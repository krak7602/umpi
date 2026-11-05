import test from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { SpeechRelay, cutOffNote, interruptedReply, type SpeechFrame } from "../src/worker/speech-relay.js";

const submission = (id: string, requestId: string, status = "placed") => ({ type: "submission", record: { id, conversationId: "c", requestId, type: "input", status } }) as unknown as AgentEvent;
const start = (...inputs: string[]) => ({ type: "run_start", inputs }) as unknown as AgentEvent;
const end = (...inputs: string[]) => ({ type: "run_end", inputs }) as unknown as AgentEvent;
const assistant = { type: "message_start", message: { role: "assistant", content: [] } } as unknown as AgentEvent;
const update = (...changes: object[]) => ({ type: "message_update", usage: {}, changes }) as unknown as AgentEvent;
const tool = (toolName: string) => ({ type: "tool_execution_start", toolCallId: "t", toolName, args: {} }) as unknown as AgentEvent;

test("passes on only the text of the run that answers the spoken message", () => {
  const frames: SpeechFrame[] = [];
  const relay = new SpeechRelay("message:telegram:app:x", frame => frames.push(frame));
  // An earlier run still answering another message: nothing of it is spoken.
  relay.handle([start("s-old"), assistant, update({ type: "text_delta", contentIndex: 0, delta: "Earlier answer." }), submission("s-1", "message:telegram:app:x", "queued")]);
  assert.deepEqual(frames, []);
  relay.handle([end("s-old"), submission("s-1", "message:telegram:app:x"), start("s-1"), assistant,
    update({ type: "thinking_delta", contentIndex: 0, delta: "private reasoning" }, { type: "text_start", contentIndex: 1, block: { type: "text", text: "Let me" } }),
    update({ type: "text_delta", contentIndex: 1, delta: " check your calendar." })]);
  relay.handle([tool("calendar_events"), assistant, update({ type: "text_delta", contentIndex: 0, delta: "You're free after four." })]);
  assert.equal(relay.done, false);
  assert.equal(relay.handle([end("s-1")]), true);
  assert.deepEqual(frames, [
    { type: "speech", operationId: "message:telegram:app:x", part: 0, text: "Let me" },
    { type: "speech", operationId: "message:telegram:app:x", part: 0, text: " check your calendar." },
    { type: "speech", operationId: "message:telegram:app:x", part: 0, working: "calendar_events" },
    { type: "speech", operationId: "message:telegram:app:x", part: 1, text: "You're free after four." },
    { type: "speech", operationId: "message:telegram:app:x", done: true },
  ]);
  assert.equal(relay.spoken, "Let me check your calendar. You're free after four.");
  assert.ok(!JSON.stringify(frames).includes("private reasoning"), "thinking is never spoken");
});

test("a whole block sends only what was not sent yet, and a snapshot can show the run already started", () => {
  const frames: SpeechFrame[] = [];
  const relay = new SpeechRelay("op", frame => frames.push(frame));
  relay.handle([submission("s-2", "op")]);
  relay.handle([{ type: "snapshot", entries: [], run: { inputs: ["s-2"] }, tools: [], compactions: [], inbox: [], agent: {}, usage: {} } as unknown as AgentEvent]);
  relay.handle([update({ type: "text_delta", contentIndex: 0, delta: "Sure, " }), update({ type: "block", contentIndex: 0, block: { type: "text", text: "Sure, done." } })]);
  assert.deepEqual(frames.map(frame => "text" in frame ? frame.text : ""), ["Sure, ", "done."]);
});

test("text written after the last saved partial, or an answer that was never streamed, is still spoken", () => {
  const frames: SpeechFrame[] = [];
  const relay = new SpeechRelay("op", frame => frames.push(frame));
  const message = (text: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text }] });
  relay.handle([submission("s-4", "op"), start("s-4"), assistant, update({ type: "text_delta", contentIndex: 1, delta: "It's two" })]);
  relay.handle([{ type: "message_end", entry: { model: [message("It's two forty-four.")] } } as unknown as AgentEvent]);
  relay.handle([tool("list_reminders"), { type: "message_start", message: message("You have three reminders.") } as unknown as AgentEvent,
    { type: "message_end", entry: { model: [message("You have three reminders.")] } } as unknown as AgentEvent,
    { type: "message_end", entry: { model: [{ role: "user", content: "ignored" }] } } as unknown as AgentEvent, end("s-4")]);
  assert.deepEqual(frames.filter(frame => "text" in frame).map(frame => [frame.part, frame.text]), [[0, "It's two"], [0, " forty-four."], [1, "You have three reminders."]]);
  assert.equal(relay.spoken, "It's two forty-four. You have three reminders.");
});

test("a spoken message settled without a run ends its relay, and a cut-off reply keeps what was said", () => {
  const frames: SpeechFrame[] = [];
  const relay = new SpeechRelay("op", frame => frames.push(frame));
  assert.equal(relay.handle([submission("s-3", "op", "withdrawn")]), true);
  assert.deepEqual(frames, [{ type: "speech", operationId: "op", done: true }]);
  relay.finish();
  assert.equal(frames.length, 1, "ends once");
  assert.equal(interruptedReply("  It's sunny and "), "It's sunny and … (cut off when you started talking)");
  assert.equal(interruptedReply(""), "(Stopped when you started talking.)");
  assert.match(cutOffNote("x".repeat(3_000)), /«…x{2000}»/, "a long heard part keeps its end");
});
