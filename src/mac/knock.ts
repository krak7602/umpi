import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KNOCK_PROMPT_MS, KNOCK_SNOOZE_MINUTES, type KnockAssignment, type KnockOutcome, type KnockPollResult, type KnockReport } from "../shared/knock.js";

/** Without a wake socket, the lane still looks for knocks once a minute. */
export const KNOCK_POLL_MS = 60_000;
/** Seconds without keyboard or mouse input after which the owner is not at the Mac. */
export const KNOCK_AWAY_SECONDS = 120;
const SAMPLE_RATE = 22_050;

/**
 * The fallback attention sound, about 24 seconds: a soft two-note chime every three seconds that starts quiet and swells
 * a little, never loud. Synthesized, so no audio asset or licence is involved. 16-bit mono PCM WAV.
 */
export function chimeSound(seconds = 24): Buffer {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  const note = (at: number, frequency: number, gain: number) => {
    const start = Math.round(at * SAMPLE_RATE), length = Math.round(2.4 * SAMPLE_RATE);
    for (let i = 0; i < length && start + i < samples.length; i++) {
      const t = i / SAMPLE_RATE;
      // A soft attack and a long decay, with a quiet octave partial, reads as a small bell rather than a beep.
      const envelope = Math.min(1, t / 0.03) * Math.exp(-t * 2.2);
      samples[start + i]! += (Math.sin(2 * Math.PI * frequency * t) + 0.18 * Math.sin(2 * Math.PI * frequency * 2 * t) * Math.exp(-t * 4)) * envelope * gain;
    }
  };
  for (let at = 0.1, round = 0; at < seconds - 2.4; at += 3, round++) {
    const gain = Math.min(0.32, 0.1 + round * 0.03);
    note(at, 659.25, gain);
    note(at + 0.38, 493.88, gain * 0.9);
  }
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32_767);
  const data = Buffer.from(pcm.buffer);
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

const TONE_LIBRARY = "/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources";
const TONE_DIRECTORIES = [`${TONE_LIBRARY}/Ringtones`, `${TONE_LIBRARY}/AlertTones/Modern`, "/System/Library/Sounds"];
/** Apple's gradual ringtone: it starts very soft and rises, which suits a call for attention. */
export const DEFAULT_KNOCK_TONE = "Slow Rise";
/** A tone shorter than this repeats; the knock sounds for about this long unless answered first. */
export const KNOCK_SOUND_MS = 24_000;

/** The Mac's built-in ringtones and alert sounds, by name. */
export function knockTones(): { name: string; path: string }[] {
  const tones: { name: string; path: string }[] = [];
  for (const directory of TONE_DIRECTORIES) {
    let files: string[] = [];
    try { files = readdirSync(directory); } catch { continue; }
    for (const file of files.sort()) {
      const match = /^(.+)\.(m4r|aiff|caf)$/.exec(file);
      if (match && !tones.some(tone => tone.name === match[1])) tones.push({ name: match[1]!, path: join(directory, file) });
    }
  }
  return tones;
}
export function knockTonePath(name: string): string | undefined { return knockTones().find(tone => tone.name === name)?.path; }

/** Plays a sound file, repeating it until the knock's sound time is over, until stopped. */
export function playKnock(path: string, duration = KNOCK_SOUND_MS): { stop(): void } {
  const until = Date.now() + duration;
  let player: ChildProcess | undefined, stopped = false;
  const next = () => {
    if (stopped || Date.now() > until - 1_500) return;
    player = spawn("/usr/bin/afplay", ["-t", String(Math.max(1, Math.round((until - Date.now()) / 1000))), path], { stdio: "ignore" });
    player.on("error", () => undefined);
    player.on("exit", next);
  };
  next();
  return { stop() { stopped = true; player?.kill("SIGTERM"); } };
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

/** Knocks on this Mac: the chime plays while the prompt waits, and stops when the owner answers. */
export function macPresenter(stateDir: string, options: { tone?: string; idle?: () => Promise<number | null> } = {}): KnockPresenter {
  const chime = join(stateDir, "chime.wav");
  return {
    async present(knock, signal) {
      const idle = await (options.idle ?? idleSeconds)();
      if (idle !== null && idle > KNOCK_AWAY_SECONDS) return "away";
      // Without Apple's tone library (an older or trimmed system), a quiet synthesized chime stands in.
      let sound = knockTonePath(options.tone ?? DEFAULT_KNOCK_TONE);
      if (!sound) { if (!existsSync(chime)) writeFileSync(chime, chimeSound(), { mode: 0o600 }); sound = chime; }
      const player = playKnock(sound);
      try {
        return await new Promise<KnockOutcome>(resolve => {
          const text = `${knock.attempt > 1 ? "Knock again: " : ""}${knock.text}`;
          execFile("/usr/bin/osascript", [...PROMPT_SCRIPT.flatMap(line => ["-e", line]), text], { timeout: KNOCK_PROMPT_MS + 15_000, signal }, (error, stdout) => {
            const value = String(stdout ?? "").trim();
            // A closed or failed prompt was not answered.
            resolve(!error && (value === "done" || value === "snoozed") ? value : "missed");
          });
        });
      } finally { player.stop(); }
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
