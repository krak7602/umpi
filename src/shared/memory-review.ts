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
