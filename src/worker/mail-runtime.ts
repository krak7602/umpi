import { parseGmailCredentials, readGmailChanges } from "./gmail.js";
import { MAIL_PRIMARY_ACCOUNT, MailStore } from "./mail-store.js";
import type { MailScreen } from "./mail-screen.js";

export interface MailAccountCredentials { id: string; credentials: string }
export const MAIL_ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_MAIL_ACCOUNTS = 4;
/** Screens per drive; the rest wait for the next wake a minute later. */
const MAIL_SCREEN_PER_DRIVE = 120;
const MAIL_SCREEN_PARALLEL = 6;
const MAIL_SCREEN_RESUME_MS = 60_000;

/**
 * `UMPI_GMAIL_CREDENTIALS` holds either one Gmail grant (the primary mailbox) or
 * `{ "accounts": [{ "id": "primary", ...grant }, { "id": "domain", ...grant }] }`.
 * Invalid entries are dropped, never partially trusted.
 */
export function parseMailAccounts(secret: string | undefined): MailAccountCredentials[] {
  let value: unknown;
  try { value = JSON.parse(secret ?? "null"); } catch { return []; }
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { accounts?: unknown }).accounts)) {
    const result: MailAccountCredentials[] = [];
    for (const entry of (value as { accounts: unknown[] }).accounts.slice(0, MAX_MAIL_ACCOUNTS)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const { id, ...grant } = entry as Record<string, unknown>;
      if (typeof id !== "string" || !MAIL_ACCOUNT_PATTERN.test(id) || result.some(account => account.id === id)) continue;
      try { result.push({ id, credentials: JSON.stringify(parseGmailCredentials(grant)) }); } catch { /* unusable grant */ }
    }
    return result;
  }
  try { return [{ id: MAIL_PRIMARY_ACCOUNT, credentials: JSON.stringify(parseGmailCredentials(value)) }]; }
  catch { return []; }
}

export class MailRuntime {
  private syncing?: Promise<void>;
  readonly accounts: MailAccountCredentials[];
  constructor(readonly store: MailStore, credentials: string | undefined, readonly wake: () => Promise<void>, private readonly screen?: MailScreen) {
    this.accounts = parseMailAccounts(credentials);
    store.screening = screen !== undefined;
  }
  available(): boolean { return this.accounts.length > 0; }
  private ids(): string[] {
    // Without any grant, the primary row still surfaces "authorization not configured" instead of silence.
    return this.accounts.length ? this.accounts.map(account => account.id) : [MAIL_PRIMARY_ACCOUNT];
  }
  private waitingScreen(): boolean { return this.screen !== undefined && this.store.settings().enabled && this.store.unscreened(1).length > 0; }
  nextDue(now = Date.now()): number | undefined {
    const due = this.store.nextDue(this.ids(), now);
    return this.waitingScreen() ? Math.min(due ?? Infinity, now + MAIL_SCREEN_RESUME_MS) : due;
  }
  async drive(now = Date.now()): Promise<void> {
    this.store.releaseSnoozes(now);
    this.store.ensureAccounts(this.ids(), now);
    if (!this.store.dueAccounts(this.ids(), now).length && !this.waitingScreen()) return;
    if (!this.syncing) this.syncing = this.sync(now).finally(() => { this.syncing = undefined; });
    await this.syncing;
  }
  private async sync(now: number): Promise<void> {
    for (const accountId of this.store.dueAccounts(this.ids(), now)) {
      const request = this.store.syncRequest(accountId);
      const account = this.accounts.find(candidate => candidate.id === accountId);
      if (!account) {
        this.store.failSync(accountId, request.settingsVersion, "Gmail authorization is not configured.", now);
        continue;
      }
      const result = await readGmailChanges(account.credentials, request, now);
      this.store.applySync(accountId, request.settingsVersion, result, Date.now());
    }
    await this.screenPending();
    await this.wake();
  }
  /** Screens new threads before any review sees them. A failed call passes the thread to the review. */
  private async screenPending(): Promise<void> {
    const screen = this.screen;
    if (!screen || !this.store.settings().enabled) return;
    let screened = 0;
    while (screened < MAIL_SCREEN_PER_DRIVE) {
      const batch = this.store.unscreened(MAIL_SCREEN_PARALLEL);
      if (!batch.length) break;
      await Promise.all(batch.map(async thread => {
        const verdict = await screen(this.store.screenInput(thread)).catch(() => null);
        this.store.applyScreen(thread.id, thread.providerVersion, verdict, Date.now());
      }));
      screened += batch.length;
    }
    if (screened) this.store.screened(Date.now());
  }
  async check(rebootstrap = false): Promise<void> {
    this.store.ensureAccounts(this.ids());
    this.store.requestCheck(Date.now(), rebootstrap);
    await this.wake();
  }
  status(): object { return { authorizationConfigured: this.available(), configuredAccounts: this.accounts.map(account => account.id), ...this.store.status() }; }
}
