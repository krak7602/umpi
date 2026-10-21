import { VaultAgent } from "@obsy/agent";
import { webEnvironment } from "@obsy/core";
import { R2Storage, type R2BucketLike } from "@obsy/storage-r2";
import { shiftPlanningDay } from "../shared/daily-planning.js";
import {
  MAX_NOTE_BYTES, parseVaultApply, parseVaultScope, vaultDayPath, vaultNoteRevision,
  type VaultPlanningApply, type VaultPlanningResult, type VaultPlanningScope, type VaultPlanningSnapshot,
} from "../shared/vault-planning.js";
import type { VaultPlanningClient } from "./planning-runtime.js";

const MAX_INPUT_BYTES = 1024 * 1024;
export const OBSY_ACTOR = "umpi";

/**
 * Daily-note reads and writes on an obsy vault through an R2 binding. The bucket's log orders every change,
 * so a write is a compare-and-swap against the revision that planning read. Devices merge umpi's commit
 * into an open note, so umpi does not wait for presence. The binding needs no device key.
 */
export class ObsyVaultClient implements VaultPlanningClient {
  private readonly storage: R2Storage;
  private readonly scope: VaultPlanningScope;
  constructor(bucket: R2BucketLike, prefix: string, scope: VaultPlanningScope) {
    this.storage = new R2Storage(bucket, { prefix });
    this.scope = parseVaultScope(scope);
  }
  private agent(run?: string): VaultAgent {
    return new VaultAgent({ storage: this.storage, env: webEnvironment(), actor: { id: OBSY_ACTOR, ...(run ? { run } : {}) }, presence: { mode: "ignore" } });
  }

  async getSnapshot(day: string): Promise<VaultPlanningSnapshot> {
    shiftPlanningDay(day, 0);
    const agent = this.agent();
    let total = 0;
    const readNote = async (path: string): Promise<string | null> => {
      const file = await agent.read(path);
      if (!file) return null;
      if (file.size > MAX_NOTE_BYTES) throw new Error("A selected note exceeds its byte limit");
      if (file.text === null) throw new Error("A selected note is not UTF-8 text");
      total += file.size;
      if (total > MAX_INPUT_BYTES) throw new Error("Planning inputs exceed their aggregate limit");
      return file.text;
    };
    const target = await readNote(vaultDayPath(this.scope, day));
    const template = await readNote(this.scope.templatePath);
    if (template === null) throw new Error("The current daily template is unavailable");
    // Only dated notes directly in the journal folder, before the day; newest three.
    const directory = `${this.scope.journalDirectory}/`, dates: string[] = [];
    for (const file of await agent.list(directory)) {
      const name = file.path.slice(directory.length);
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
      const date = name.slice(0, -3);
      try { shiftPlanningDay(date, 0); } catch { continue; }
      if (date < day) dates.push(date);
    }
    const recent: VaultPlanningSnapshot["recent"] = [];
    for (const date of dates.sort().reverse().slice(0, 3)) {
      const path = vaultDayPath(this.scope, date), text = await readNote(path);
      if (text !== null) recent.push({ path, text });
    }
    return { day, checkedAt: new Date().toISOString(), revision: vaultNoteRevision(target), target, template, recent };
  }

  async applyNote(value: VaultPlanningApply): Promise<VaultPlanningResult> {
    const intent = parseVaultApply(value), path = vaultDayPath(this.scope, intent.day);
    const checked = () => new Date().toISOString();
    let revision = intent.beforeRevision;
    try {
      const agent = this.agent(intent.intentId);
      const current = await agent.read(path);
      if (current && current.text === null) return { status: "conflict", revision, checkedAt: checked(), issue: "The daily note is not UTF-8 text; owner review is required" };
      const text = current?.text ?? null;
      revision = vaultNoteRevision(text);
      // Also covers a retry after a lost response: the earlier commit already landed.
      if (text === intent.text) return { status: "synced", revision, checkedAt: checked() };
      if (revision !== intent.beforeRevision) return { status: "conflict", revision, checkedAt: checked(), issue: "Daily note changed after planning; no replacement was made" };
      // Expiry is checked right before the only write.
      if (!Number.isFinite(Date.parse(intent.expiresAt)) || Date.parse(intent.expiresAt) <= Date.now()) throw new Error("Daily write authorization has expired");
      const result = await agent.replaceIfUnchanged(path, intent.text, { baseRev: current?.rev ?? null, toolCall: intent.intentId });
      if (result.status === "committed" || result.status === "unchanged") return { status: "synced", revision: vaultNoteRevision(intent.text), checkedAt: checked() };
      if (result.status === "changed") return { status: "conflict", revision, checkedAt: checked(), issue: "Daily note changed between the read and the commit; no replacement was made" };
      throw new Error(`Unexpected obsy result: ${result.status}`);
    } catch {
      // Retrying the same intent is safe: the next read finds the intended text if the commit landed.
      return { status: "unconfirmed", revision, checkedAt: checked(), issue: "The obsy commit was not confirmed; retain this intent and resume it to check" };
    }
  }
}
