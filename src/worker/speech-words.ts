import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { InputError, record } from "../shared/protocol.js";
import { StateError, type Database } from "./store.js";

/**
 * The owner's speech words: names and terms that speech recognition gets wrong, written the way the owner spells
 * them. The apps' recognizers correct towards them, and Telegram voice notes pass them to the transcriber as a hint.
 * The list starts empty; nothing about any one owner ships with the code.
 */
export interface SpeechWords { words: string[]; version: number }

/** Recognizers bias best with a short list; a long one makes them hear its words where they were not said. */
export const MAX_SPEECH_WORDS = 100;
export const MAX_SPEECH_WORD_LENGTH = 48;

export function speechWord(value: unknown): string {
  if (typeof value !== "string") throw new InputError("A speech word must be text");
  const word = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!word) throw new InputError("A speech word cannot be empty");
  if (word.length > MAX_SPEECH_WORD_LENGTH) throw new InputError(`A speech word is at most ${MAX_SPEECH_WORD_LENGTH} characters`);
  if (/[\p{Cc}\p{Cf}]/u.test(word)) throw new InputError("A speech word cannot contain control characters");
  return word;
}

/** Each word once, compared without case; the first spelling stays. */
function distinct(words: string[]): string[] {
  const seen = new Set<string>();
  return words.filter(word => { const key = word.toLocaleLowerCase("en"); if (seen.has(key)) return false; seen.add(key); return true; });
}

function wordList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new InputError("words must be a list");
  if (value.length > MAX_SPEECH_WORDS * 2) throw new InputError(`At most ${MAX_SPEECH_WORDS} speech words`);
  return distinct(value.map(speechWord));
}

export class SpeechWordStore {
  constructor(private readonly db: Database) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_speech_words (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }

  read(): SpeechWords {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_speech_words WHERE id='words'")[0];
    return row ? JSON.parse(row.data) as SpeechWords : { words: [], version: 1 };
  }

  /** The app's edit: the whole list, against the version it was shown. */
  replace(value: unknown): SpeechWords {
    const input = record(value);
    if (Object.keys(input).some(key => !["expectedVersion", "words"].includes(key))) throw new InputError("Unknown speech words field");
    const words = wordList(input.words);
    return this.db.transaction(() => {
      const current = this.read();
      if (input.expectedVersion !== current.version) throw new StateError(409, `Speech words changed; expected version ${current.version}`);
      return this.write(words, current.version);
    });
  }

  /** Umpi's edit: words added at the end and removed by spelling, without case. */
  change(add: string[], remove: string[]): SpeechWords & { added: string[]; removed: string[] } {
    return this.db.transaction(() => {
      const current = this.read();
      const dropping = new Set(remove.map(word => word.toLocaleLowerCase("en")));
      const kept = current.words.filter(word => !dropping.has(word.toLocaleLowerCase("en")));
      const known = new Set(kept.map(word => word.toLocaleLowerCase("en")));
      const added = distinct(add).filter(word => !known.has(word.toLocaleLowerCase("en")));
      const removed = current.words.filter(word => dropping.has(word.toLocaleLowerCase("en")));
      if (!added.length && !removed.length) return { ...current, added, removed };
      return { ...this.write([...kept, ...added], current.version), added, removed };
    });
  }

  private write(words: string[], version: number): SpeechWords {
    if (words.length > MAX_SPEECH_WORDS) throw new InputError(`At most ${MAX_SPEECH_WORDS} speech words; remove some first`);
    const next = { words, version: version + 1 };
    this.db.all("INSERT INTO umpi_speech_words VALUES ('words', ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify(next));
    return next;
  }
}

/** A hint for a transcriber that takes a text prompt, such as the voice-note model; undefined with no words. */
export function speechWordsPrompt(words: string[]): string | undefined {
  return words.length ? `Names and terms that may come up: ${words.join(", ")}.` : undefined;
}

export function speechWordTools(store: SpeechWordStore, isBackground: (conversationId: string) => boolean): ToolRegistration[] {
  async function result(run: () => unknown): Promise<ToolExecutionResult> {
    try { return { content: [{ type: "text", text: JSON.stringify(run()) }] }; }
    catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof InputError || error instanceof StateError
        ? error.message : "The speech words could not be changed." }] };
    }
  }
  const Word = Type.String({ minLength: 1, maxLength: MAX_SPEECH_WORD_LENGTH });
  return [
    defineTool({ name: "speech_words",
      description: "Read or change the owner's speech words: names and terms that speech recognition gets wrong, written the way the owner spells them (products, people, places, jargon). Voice mode on the phone and the Mac corrects towards them, and Telegram voice notes use them as a hint. Add a word when the owner corrects a misheard name or term, or asks you to remember how one is written, and say in a few words what you added. Never add ordinary words: the recognizer then hears them where they were not said. Remove a word when the owner asks.",
      parameters: Type.Object({
        add: Type.Optional(Type.Array(Word, { maxItems: 20 })),
        remove: Type.Optional(Type.Array(Word, { maxItems: MAX_SPEECH_WORDS })),
      }, { additionalProperties: false }), replay: "safe",
      async execute(input, api) { return result(() => {
        if (isBackground(String(api.conversationId))) throw new StateError(403, "Speech words change only in the owner's own conversation");
        const body = record(input);
        if (Object.keys(body).some(key => !["add", "remove"].includes(key))) throw new InputError("Unknown speech words field");
        const add = body.add === undefined ? [] : wordList(body.add);
        const remove = body.remove === undefined ? [] : wordList(body.remove);
        return store.change(add, remove);
      }); } }),
  ];
}
