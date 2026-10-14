import { parseGmailCredentials, readGmailChanges } from "./gmail.js";
import { MailStore } from "./mail-store.js";

export class MailRuntime {
  private syncing?: Promise<void>;
  constructor(readonly store: MailStore, private readonly credentials: string | undefined, readonly wake: () => Promise<void>) {}
  available(): boolean {
    try { parseGmailCredentials(JSON.parse(this.credentials ?? "null")); return true; }
    catch { return false; }
  }
  nextDue(now = Date.now()): number | undefined { return this.store.nextDue(now); }
  async drive(now = Date.now()): Promise<void> {
    this.store.releaseSnoozes(now);
    if (!this.store.due(now)) return;
    if (!this.syncing) this.syncing = this.sync(now).finally(() => { this.syncing = undefined; });
    await this.syncing;
  }
  private async sync(now: number): Promise<void> {
    const request = this.store.syncRequest();
    if (!this.available()) {
      this.store.failSync(request.settingsVersion, "Gmail authorization is not configured.", now);
      await this.wake();
      return;
    }
    const result = await readGmailChanges(this.credentials, request, now);
    this.store.applySync(request.settingsVersion, result, Date.now());
    await this.wake();
  }
  async check(rebootstrap = false): Promise<void> {
    this.store.requestCheck(Date.now(), rebootstrap);
    await this.wake();
  }
  status(): object { return { authorizationConfigured: this.available(), ...this.store.status() }; }
}
