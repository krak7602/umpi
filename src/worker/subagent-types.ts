import type { Context } from "@earendil-works/chord";
import type { Extension, Harness, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Channel } from "./store.js";

export type SubagentScope =
  | { kind: "assistant"; parentSessionId: string; channel: Channel }
  | { kind: "coding"; parentSessionId: string; taskId: string; runId: string; deadlineAt: string };

export type SubagentReport = {
  id: string;
  agentId: string;
  name: string;
  version: number;
  scope: SubagentScope;
  outcome: "done" | "failed" | "cancelled" | "expired";
  text: string;
  createdAt: string;
};

export type SubagentScopeReader = (api: ToolExecutionApi, context: Context) => Promise<SubagentScope>;

export interface SubagentRuntimeHost {
  harness(): Promise<Harness>;
  scope(parentSessionId: string): SubagentScope;
  validate(scope: SubagentScope): void;
  profile(scope: SubagentScope): Extension;
  deliver(report: SubagentReport): Promise<void>;
  wake(): Promise<void>;
  track(work: Promise<void>): void;
}

export interface CodingSubagentHost {
  active(parentSessionId: string, runId: string): Promise<boolean>;
  stop(parentSessionId: string, runId: string): Promise<void>;
  correct(parentSessionId: string, runId: string, inputId: string, text: string): Promise<void>;
}
