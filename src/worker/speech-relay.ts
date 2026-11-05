import type { AgentEvent, SubmissionId } from "@earendil-works/pi-durable";

/**
 * A spoken reply as it is written: what the phone reads aloud while Claude is still answering. Frames go over the
 * app's chat socket. `part` counts the answer's model messages, so text written before a tool call ("Let me check
 * your calendar") and the answer after it are separate parts. The finished reply still arrives as a chat entry.
 */
export type SpeechFrame =
  | { type: "speech"; operationId: string; part: number; text: string }
  | { type: "speech"; operationId: string; part: number; working: string }
  | { type: "speech"; operationId: string; done: true };

/** Added to a spoken app message's model input. */
export const SPOKEN_TURN_NOTE = "This is a spoken conversation: the owner is talking to Umpi in the app's voice mode, and the phone reads your reply aloud as you write it. Answer in short, natural spoken sentences. Do not use Markdown, lists, tables, headings, links, emoji, or code; say numbers, times, and symbols the way a person says them. Keep it brief unless the owner asks for detail. When you need tools or longer work, first write one short sentence that says what you are doing (never a filler such as \"one moment\"), then the answer.";

/** Told to Umpi with the message that cut off its spoken reply: the reply may be written in full, but was not heard in full. */
export function cutOffNote(heard: string): string {
  const text = heard.trim();
  return text
    ? `The owner talked over your previous spoken reply, so they heard only this much of it: «${text.length > 2_000 ? `…${text.slice(-2_000)}` : text}». Anything after that was not heard.`
    : "The owner talked over your previous spoken reply before hearing any of it.";
}

/** Text Umpi keeps for a spoken reply the owner cut off by talking. */
export function interruptedReply(spoken: string): string {
  const text = spoken.trim();
  return text ? `${text} … (cut off when you started talking)` : "(Stopped when you started talking.)";
}

type Block = { type: string; text?: string };

/**
 * Follows one conversation's agent events and passes on the text of the run that answers `operationId`. The run is
 * found through the submission whose request ID is the operation: Umpi submits each owner turn with its operation ID,
 * and a run lists the submissions it answers. Runs for other inputs, and thinking, are never passed on.
 */
export class SpeechRelay {
  private submission: SubmissionId | undefined;
  private active = false;
  private part = 0;
  private partHasText = false;
  /** Characters already sent, per content block of the current message. */
  private sent = new Map<number, number>();
  private finished = false;
  /** Everything passed on, for the chat entry of a reply that was cut off. */
  spoken = "";

  constructor(readonly operationId: string, private readonly send: (frame: SpeechFrame) => void) {}

  get done(): boolean { return this.finished; }

  /** Takes one batch of events; returns true once the reply has ended. */
  handle(events: readonly AgentEvent[]): boolean {
    for (const event of events) {
      if (this.finished) break;
      switch (event.type) {
        case "submission":
          if (event.record.requestId === this.operationId) {
            this.submission = event.record.id;
            // Settled without a run of its own, for example withdrawn while queued.
            if (!this.active && !["queued", "placed"].includes((event.record as { status: string }).status)) this.finish();
          }
          break;
        case "snapshot":
          if (this.submission && event.run?.inputs.includes(this.submission)) this.active = true;
          break;
        case "run_start":
          if (this.submission && event.inputs.includes(this.submission)) this.active = true;
          break;
        case "message_start":
          // An answer that was not streamed starts whole; a streamed one starts with its first partial.
          if (this.active && event.message.role === "assistant") { this.nextPart(); this.whole(event.message.content); }
          break;
        case "message_end": {
          // The finished message: text written after the last saved partial is only here.
          const message = event.entry.model?.[0];
          if (this.active && message?.role === "assistant") this.whole(message.content);
          break;
        }
        case "message_update":
          if (!this.active) break;
          for (const change of event.changes) {
            if (change.type === "text_delta") this.text(change.contentIndex, change.delta, true);
            else if ((change.type === "text_start" || change.type === "block") && (change.block as Block).type === "text") this.text(change.contentIndex, (change.block as Block).text ?? "", false);
            else if (change.type === "message") this.whole(change.message.content);
          }
          break;
        case "tool_execution_start":
          if (this.active) this.send({ type: "speech", operationId: this.operationId, part: this.part, working: event.toolName });
          break;
        case "run_end":
          if (this.active && this.submission && event.inputs.includes(this.submission)) this.finish();
          break;
        default:
          break;
      }
    }
    return this.finished;
  }

  /** Ends the reply now, for example when it was stopped or the watch ended. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.send({ type: "speech", operationId: this.operationId, done: true });
  }

  private whole(content: readonly unknown[]): void {
    content.forEach((block, index) => { if ((block as Block).type === "text") this.text(index, (block as Block).text ?? "", false); });
  }

  private nextPart(): void {
    if (this.partHasText) { this.part++; this.partHasText = false; }
    this.sent.clear();
  }

  /** `delta` appends to a block; otherwise `value` is the block's whole text so far and only its new end is sent. */
  private text(index: number, value: string, delta: boolean): void {
    const already = this.sent.get(index) ?? 0;
    const fresh = delta ? value : value.slice(already);
    if (!fresh) return;
    this.sent.set(index, already + fresh.length);
    this.partHasText = true;
    this.spoken += (this.spoken && this.part > 0 && already === 0 && !this.spoken.endsWith(" ") ? " " : "") + fresh;
    this.send({ type: "speech", operationId: this.operationId, part: this.part, text: fresh });
  }
}
