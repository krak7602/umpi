import { createHash } from "node:crypto";
import { InputError, boundedText, identifier, record, timestamp } from "./protocol.js";
import { shiftPlanningDay } from "./daily-planning.js";

export interface VaultPlanningScope { journalDirectory: string; templatePath: string }
export interface VaultRecentNote { path: string; text: string }
export interface VaultPlanningSnapshot {
  day: string; checkedAt: string; revision: string; target: string | null;
  template: string; recent: VaultRecentNote[];
}
export interface VaultPlanningApply {
  intentId: string; day: string; beforeRevision: string; text: string; expiresAt: string;
}
export interface VaultPlanningResult {
  status: "synced" | "conflict" | "unconfirmed";
  revision: string; checkedAt: string; issue?: string;
}
export const MAX_NOTE_BYTES = 262_144;
export const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_VAULT_SCOPE: VaultPlanningScope = { journalDirectory: "journals", templatePath: "templates/date-template.md" };

/** A content revision distinguishes an absent note from every possible note body. */
export function vaultNoteRevision(text: string | null): string {
  return createHash("sha256").update(JSON.stringify(text)).digest("hex");
}
function relativePath(value: unknown, label: string): string {
  const path = boundedText(value, 512, label);
  if (path.includes("\\") || path.includes(":") || /[\u0000-\u001f\u007f]/u.test(path) ||
      path.split("/").some(part => !part || part.startsWith(".") || part.trim() !== part)) {
    throw new InputError("Vault paths must be relative, visible paths without traversal");
  }
  return path;
}
export function parseVaultScope(value: unknown): VaultPlanningScope {
  const body = record(value);
  if (Object.keys(body).some(key => !["journalDirectory", "templatePath"].includes(key))) throw new InputError("Unknown vault scope field");
  const journalDirectory = relativePath(body.journalDirectory, "journal directory");
  const templatePath = relativePath(body.templatePath, "template path");
  if (!templatePath.endsWith(".md") || templatePath.startsWith(`${journalDirectory}/`)) throw new InputError("The template must be a separate Markdown file");
  return { journalDirectory, templatePath };
}
export function vaultDayPath(scope: VaultPlanningScope, day: string): string {
  shiftPlanningDay(day, 0);
  return `${scope.journalDirectory}/${day}.md`;
}
export function parseVaultApply(value: unknown): VaultPlanningApply {
  const body = record(value);
  if (Object.keys(body).some(key => !["intentId", "day", "beforeRevision", "text", "expiresAt"].includes(key))) throw new InputError("Unknown vault write field");
  const intentId = identifier(body.intentId, "write intent");
  const day = boundedText(body.day, 10, "planning day"); shiftPlanningDay(day, 0);
  if (typeof body.beforeRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.beforeRevision)) throw new InputError("Invalid note revision");
  const text = boundedText(body.text, MAX_NOTE_BYTES, "daily note");
  if (new TextEncoder().encode(text).byteLength > MAX_NOTE_BYTES) throw new InputError("Daily note exceeds its byte limit");
  return { intentId, day, beforeRevision: body.beforeRevision, text, expiresAt: timestamp(body.expiresAt, "write expiry") };
}
