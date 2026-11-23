import type { CoreBlock, CoreContext } from "./core-context.js";

export const MAX_PENDING_MEMORY_REVIEWS = 64;
export const MAX_MEMORY_REVIEW_REASON_LENGTH = 2_000;
export const MAX_MEMORY_HISTORY_PAGE_SIZE = 50;

export type MemoryReview = {
  id: string;
  blockId: string;
  expectedRevision: number;
  before: CoreBlock;
  afterText: string;
  reason: string;
  kind: "update" | "restore";
  restoreRevision?: number;
  status: "pending" | "approved" | "rejected" | "stale";
  createdAt: string;
  decidedAt?: string;
  appliedRevision?: number;
  conversationId?: string;
};

export type MemoryHistoryEntry = {
  revision: number;
  at: string;
  source: "baseline" | "source_sync" | "approved_update" | "approved_restore";
  reviewId?: string;
  context: CoreContext;
};

export type MemoryHistoryPage = {
  entries: MemoryHistoryEntry[];
  nextBeforeRevision: number | null;
};

export type MemoryChange = { op: "remove" | "add"; text: string };
const MAX_DIFF_LINES = 400;

/**
 * The lines a review removes and adds, in reading order, so the owner sees the change before the whole topic.
 * Unchanged lines are left out. Undefined when the topic is too long to compare line by line; the complete
 * before-and-after text is always shown as well.
 */
export function memoryChanges(before: string, after: string): MemoryChange[] | undefined {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return undefined;
  // Longest common subsequence of lines; what is outside it was removed or added.
  const common: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  }
  const changes: MemoryChange[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (i < a.length && (j === b.length || common[i + 1]![j]! >= common[i]![j + 1]!)) changes.push({ op: "remove", text: a[i++]! });
    else changes.push({ op: "add", text: b[j++]! });
  }
  // Blank lines are spacing, not content: an empty topic is one empty line, and it is not "removed" by the first text.
  return changes.filter(change => change.text.trim() !== "");
}
