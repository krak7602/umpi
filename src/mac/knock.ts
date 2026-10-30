import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KNOCK_PROMPT_MS, KNOCK_SNOOZE_MINUTES, type KnockAssignment, type KnockOutcome, type KnockPollResult, type KnockReport } from "../shared/knock.js";

/** Without a wake socket, the lane still looks for knocks once a minute. */
export const KNOCK_POLL_MS = 60_000;
/** Seconds without keyboard or mouse input after which the owner is not at the Mac. */
export const KNOCK_AWAY_SECONDS = 120;
const SAMPLE_RATE = 22_050;

/**
 * A knock sound of about 25 seconds: groups of knocks on wood with pauses, a little firmer towards the end.
 * Synthesized, so no audio asset or licence is involved. 16-bit mono PCM WAV.
 */
export function knockSound(seconds = 25): Buffer {
  const samples = new Int16Array(Math.round(seconds * SAMPLE_RATE));
  let seed = 7;
  const noise = () => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  const hit = (at: number, gain: number) => {
    const start = Math.round(at * SAMPLE_RATE), length = Math.round(0.09 * SAMPLE_RATE);
    for (let i = 0; i < length && start + i < samples.length; i++) {
      const t = i / SAMPLE_RATE, envelope = Math.exp(-t * 55);
      // A low body resonance plus a short noisy attack reads as a knuckle on a door or table.
      const value = (Math.sin(2 * Math.PI * 180 * t) * 0.7 + Math.sin(2 * Math.PI * 410 * t) * 0.25 + noise() * Math.exp(-t * 300) * 0.5) * envelope * gain;
      samples[start + i] = Math.max(-32_767, Math.min(32_767, samples[start + i]! + value * 32_767));
    }
  };
  for (let group = 0, at = 0.2; at < seconds - 1; group++) {
    const gain = Math.min(0.95, 0.45 + group * 0.06);
    const pattern = group % 2 === 0 ? [0, 0.22] : [0, 0.2, 0.4];
    for (const offset of pattern) hit(at + offset, gain);
    at += 2.6;
  }
  const data = Buffer.from(samples.buffer);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Seconds since the last keyboard or mouse input, from the HID system; null when it cannot be read. */
export function idleSeconds(): Promise<number | null> {
  return new Promise(resolve => {
    execFile("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout ?? "");
      resolve(error || !match ? null : Math.floor(Number(match[1]) / 1e9));
    });
  });
}

/** The prompt's text goes in as an argument, never into the script, so reminder text cannot become AppleScript. */
const PROMPT_SCRIPT = [
  "on run argv",
  `set answer to display dialog (item 1 of argv) with title "Umpi" buttons {"Snooze ${KNOCK_SNOOZE_MINUTES} min", "Done"} default button "Done" giving up after ${Math.round(KNOCK_PROMPT_MS / 1000)} with icon note`,
  "if gave up of answer then return \"missed\"",
  "if button returned of answer is \"Done\" then return \"done\"",
  "return \"snoozed\"",
  "end run",
];

export interface KnockPresenter { present(knock: KnockAssignment, signal: AbortSignal): Promise<KnockOutcome> }

/** Knocks on this Mac: the sound plays while the prompt waits, and stops when the owner answers. */
export function macPresenter(stateDir: string, options: { idle?: () => Promise<number | null> } = {}): KnockPresenter {
  const sound = join(stateDir, "knock.wav");
  return {
    async present(knock, signal) {
      const idle = await (options.idle ?? idleSeconds)();
      if (idle !== null && idle > KNOCK_AWAY_SECONDS) return "away";
      if (!existsSync(sound)) writeFileSync(sound, knockSound(), { mode: 0o600 });
      const player: ChildProcess = spawn("/usr/bin/afplay", [sound], { stdio: "ignore" });
      player.on("error", () => undefined);
      try {
        return await new Promise<KnockOutcome>(resolve => {
          const text = `${knock.attempt > 1 ? "Knock again: " : ""}${knock.text}`;
          execFile("/usr/bin/osascript", [...PROMPT_SCRIPT.flatMap(line => ["-e", line]), text], { timeout: KNOCK_PROMPT_MS + 15_000, signal }, (error, stdout) => {
            const value = String(stdout ?? "").trim();
            // A closed or failed prompt was not answered.
            resolve(!error && (value === "done" || value === "snoozed") ? value : "missed");
          });
        });
      } finally { player.kill("SIGTERM"); }
    },
  };
}

export interface KnockTransport {
  poll(signal?: AbortSignal): Promise<KnockPollResult>;
  report(report: KnockReport, signal?: AbortSignal): Promise<void>;
}

/**
 * The knock lane. A wake or the minute timer starts a poll; knocks are shown one at a time in the background, so
 * the prompt never delays commands, coding, browser or Aside work. Unsent answers are retried on the next tick.
 */
export class KnockLane {
  private woken = true;
  private lastPoll = -Infinity;
  private running: Promise<void> | undefined;
  private readonly queue: KnockAssignment[] = [];
  private readonly unsent: KnockReport[] = [];

  constructor(private readonly executorId: string, private readonly presenter: KnockPresenter, private readonly options: { emit(event: string): void; now?(): number }) {}

  wake(): void { this.woken = true; }
  get busy(): boolean { return this.running !== undefined; }

  async tick(transport: KnockTransport, signal: AbortSignal): Promise<void> {
    while (this.unsent.length) { await transport.report(this.unsent[0]!, signal); this.unsent.shift(); }
    const now = this.options.now?.() ?? Date.now();
    if (!this.woken && now - this.lastPoll < KNOCK_POLL_MS) return;
    this.woken = false; this.lastPoll = now;
    const { knocks } = await transport.poll(signal);
    for (const knock of knocks) if (!this.queue.some(item => item.id === knock.id && item.attempt === knock.attempt)) this.queue.push(knock);
    if (!this.running && this.queue.length) this.running = this.drain(transport, signal).finally(() => { this.running = undefined; });
  }

  private async drain(transport: KnockTransport, signal: AbortSignal): Promise<void> {
    while (this.queue.length && !signal.aborted) {
      const knock = this.queue.shift()!;
      let outcome: KnockOutcome;
      try { outcome = await this.presenter.present(knock, signal); } catch { outcome = "missed"; }
      if (signal.aborted) return;
      this.options.emit(`knock_${outcome}`);
      const report = { executorId: this.executorId, id: knock.id, attempt: knock.attempt, outcome };
      try { await transport.report(report, signal); } catch { this.unsent.push(report); }
    }
  }

  async idle(): Promise<void> { await this.running; }
}
