import { InputError, boundedText, identifier, record } from "./protocol.js";

/**
 * A knock is how a due reminder gets the owner's attention: a sound and a small Done/Snooze prompt on the device
 * the owner is using. The Telegram message stays as the written record.
 */
export const KNOCK_OUTCOMES = ["done", "snoozed", "missed", "away"] as const;
export type KnockOutcome = typeof KNOCK_OUTCOMES[number];
export const REMINDER_INTENSITIES = ["knock", "gentle"] as const;
export type ReminderIntensity = typeof REMINDER_INTENSITIES[number];

/** A knock repeats twice more, three minutes apart, unless answered; a gentle one knocks once. */
export const KNOCK_ATTEMPTS: Record<ReminderIntensity, number> = { knock: 3, gentle: 1 };
export const KNOCK_RETRY_MS = 3 * 60_000;
/** A knock not delivered within half an hour is stale; the Telegram message remains. */
export const KNOCK_EXPIRY_MS = 30 * 60_000;
/** The Mac's prompt gives up after two minutes; a claim unanswered for longer counts as a missed attempt. */
export const KNOCK_PROMPT_MS = 2 * 60_000;
export const KNOCK_CLAIM_MS = 4 * 60_000;
export const KNOCK_SNOOZE_MINUTES = 10;

export interface KnockAssignment { id: string; attempt: number; text: string; intensity: ReminderIntensity }
export interface KnockPollResult { knocks: KnockAssignment[] }
export interface KnockReport { executorId: string; id: string; attempt: number; outcome: KnockOutcome }

const knockId = (value: unknown) => {
  const id = boundedText(value, 200, "knock ID");
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) throw new InputError("Invalid knock ID");
  return id;
};
const attempt = (value: unknown) => {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10) throw new InputError("Invalid knock attempt");
  return value as number;
};

export function parseReminderIntensity(value: unknown): ReminderIntensity {
  if (value === undefined) return "knock";
  if (!REMINDER_INTENSITIES.includes(value as ReminderIntensity)) throw new InputError("Invalid reminder intensity");
  return value as ReminderIntensity;
}
export function parseKnockPoll(value: unknown): { executorId: string } {
  return { executorId: identifier(record(value).executorId, "executor ID") };
}
export function parseKnockPollResult(value: unknown): KnockPollResult {
  const input = record(value);
  if (!Array.isArray(input.knocks) || input.knocks.length > 10) throw new InputError("Invalid knock list");
  return { knocks: input.knocks.map(item => {
    const knock = record(item);
    return { id: knockId(knock.id), attempt: attempt(knock.attempt), text: boundedText(knock.text, 4_096, "knock text"), intensity: parseReminderIntensity(knock.intensity) };
  }) };
}
export function parseKnockReport(value: unknown): KnockReport {
  const input = record(value);
  if (!KNOCK_OUTCOMES.includes(input.outcome as KnockOutcome)) throw new InputError("Invalid knock outcome");
  return { executorId: identifier(input.executorId, "executor ID"), id: knockId(input.id), attempt: attempt(input.attempt), outcome: input.outcome as KnockOutcome };
}
