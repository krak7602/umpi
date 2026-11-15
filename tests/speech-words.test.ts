import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { InputError } from "../src/shared/protocol.js";
import { MAX_SPEECH_WORDS, SpeechWordStore, speechWordTools, speechWordsPrompt } from "../src/worker/speech-words.js";
import { StateError, type Database } from "../src/worker/store.js";
import { transcribeSubscriptionAudio } from "../src/worker/subscription-transcription.js";

function store(t: TestContext): SpeechWordStore {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const name = `words_${depth++}`; sqlite.exec(`SAVEPOINT ${name}`);
      try { const value = run(); sqlite.exec(`RELEASE ${name}`); return value; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
  return new SpeechWordStore(db);
}

test("the app replaces the whole list against its version; words are cleaned and kept once", t => {
  const words = store(t);
  assert.deepEqual(words.read(), { words: [], version: 1 });
  assert.deepEqual(words.replace({ expectedVersion: 1, words: ["  Kubernetes ", "kubernetes", "Home\tAssistant"] }), { words: ["Kubernetes", "Home Assistant"], version: 2 });
  assert.throws(() => words.replace({ expectedVersion: 1, words: [] }), (error: unknown) => error instanceof StateError && error.status === 409);
  for (const bad of [[""], ["x".repeat(49)], ["a\u0000b"], [7], "Kubernetes"]) assert.throws(() => words.replace({ expectedVersion: 2, words: bad }), InputError);
  assert.throws(() => words.replace({ expectedVersion: 2, words: [], extra: true }), InputError);
  assert.throws(() => words.replace({ expectedVersion: 2, words: Array.from({ length: MAX_SPEECH_WORDS + 1 }, (_, i) => `Term${i}`) }), InputError);
  assert.deepEqual(words.read(), { words: ["Kubernetes", "Home Assistant"], version: 2 }, "a refused edit changes nothing");
});

test("Umpi adds and removes words without case and without a version", t => {
  const words = store(t);
  words.replace({ expectedVersion: 1, words: ["Kubernetes"] });
  assert.deepEqual(words.change(["Grafana", "KUBERNETES", "Figma"], []), { words: ["Kubernetes", "Grafana", "Figma"], version: 3, added: ["Grafana", "Figma"], removed: [] });
  assert.deepEqual(words.change([], ["figma", "Missing"]), { words: ["Kubernetes", "Grafana"], version: 4, added: [], removed: ["Figma"] });
  assert.equal(words.change(["kubernetes"], []).version, 4, "nothing new writes nothing");
});

test("the tool changes words only in the owner's conversation", async t => {
  const words = store(t);
  const [tool] = speechWordTools(words, id => id === "background");
  const run = (input: unknown, conversationId: string) => tool!.execute(input as never, { conversationId } as never, undefined as never);
  const done = await run({ add: ["Grafana"] }, "owner");
  assert.ok(!done.isError);
  assert.deepEqual(words.read().words, ["Grafana"]);
  const refused = await run({ add: ["Figma"] }, "background");
  assert.ok(refused.isError);
  assert.deepEqual(words.read().words, ["Grafana"]);
});

test("voice notes pass the words to the transcriber as a prompt, and nothing without words", async t => {
  assert.equal(speechWordsPrompt([]), undefined);
  assert.equal(speechWordsPrompt(["Kubernetes", "Figma"]), "Names and terms that may come up: Kubernetes, Figma.");
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    bodies.push(await new Response(init.body as ReadableStream).text());
    return Response.json({ text: "hello" });
  });
  const audio = { bytes: new Uint8Array([79, 103, 103, 83, 0, 1]), filename: "voice-note.ogg", mimeType: "audio/ogg" } as const;
  const auth = async () => ({ access: "synthetic-access" });
  await transcribeSubscriptionAudio(audio, auth, new AbortController().signal, speechWordsPrompt(["Kubernetes"]));
  await transcribeSubscriptionAudio(audio, auth, new AbortController().signal);
  assert.match(bodies[0]!, /name="prompt"\r\n\r\nNames and terms that may come up: Kubernetes\.\r\n/);
  assert.match(bodies[0]!, /name="model"/);
  assert.doesNotMatch(bodies[1]!, /name="prompt"/);
});
