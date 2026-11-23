import type { Effort } from "./decisions.js";
import type { ModelInput, Operation, Store } from "./store.js";

/** How long one wait on a running turn lasts. A wait that reaches the limit is renewed at once, and reads the turn's state again. */
export const TURN_WAIT_MS = 20_000;
/** How often the coordinator checks running turns whose waits are attached. The waits bring the results; this is the safety check. */
export const TURN_CHECK_MS = 30_000;
/** How soon the coordinator runs again for a running turn that has no wait, such as after a wait failed. */
export const TURN_RETRY_MS = 2_000;

export interface TurnAnswer { status: string; text?: string; reason?: string }

/** What the turn driver needs from the coordinator. The `Assistant` Durable Object gives the real parts; a test gives its own. */
export interface TurnHost {
  store: Pick<Store, "pendingOperations" | "operation" | "settle" | "submitted" | "modelContent" | "hasForegroundInput">;
  harness: {
    submit(input: ModelInput, options: { session: string; operationId: string }): Promise<unknown>;
    wait(operationId: string, options: { session: string; signal: AbortSignal }): Promise<TurnAnswer>;
    abort(options: { session: string; operationId: string }): Promise<unknown>;
  };
  modelReady(): Promise<boolean>;
  /** Before an owner turn is submitted: sets its reasoning effort. It may take up to the effort decision's limit. */
  prepare(op: Operation): Promise<void>;
  /** Directly before the submit, when the turn is still admitted: attaches what must not miss the run, such as the speech relay. */
  beforeSubmit(op: Operation): Promise<void>;
  /** Whether a background review's turn still has a review that may run. */
  backgroundActionable(op: Operation): boolean;
  /** Whether the review of a background turn is still the current one of its session. */
  backgroundCurrent(op: Operation): boolean;
  /** Writes the result of a turn the model has ended. */
  finish(op: Operation, answer: TurnAnswer): Promise<void>;
  /** A wait ended with an error that is not its own time limit. */
  resultFailed(error: unknown): void;
  /** One turn could not be driven; the others still are. */
  driveFailed(error: unknown): void;
  /** Runs the coordinator's reconciliation now. */
  wake(): Promise<void>;
  /** Keeps detached work inside the alarm's accounting. */
  track(work: Promise<void>): void;
}

/**
 * Submits admitted turns and follows submitted ones to their result.
 *
 * A turn can be submitted from two places: the request that admitted it (`submitDirect`) and the coordinator's
 * reconciliation (`drive`). Only the reconciliation attaches the wait that brings the result, so the request path wakes
 * the coordinator after its submit. Without that wake, a reconciliation that ran while the effort decision was pending
 * saw the turn as admitted, attached nothing, and the finished reply waited for an unrelated wake.
 */
export class Turns {
  private readonly waits = new Map<string, Promise<void>>();
  private readonly submitting = new Set<string>();
  constructor(private readonly host: TurnHost) {}

  /**
   * Submits one admitted owner turn after setting its reasoning effort. The request path and the coordinator can both
   * reach the same turn while the effort decision is pending; only the first submits it. Returns whether the turn is
   * submitted now.
   */
  async submitOwner(op: Operation): Promise<boolean> {
    const { store, harness } = this.host;
    if (this.submitting.has(op.id)) return false;
    this.submitting.add(op.id);
    try {
      if (store.operation(op.id)?.status === "admitted") {
        await this.host.prepare(op);
        if (store.operation(op.id)?.status === "admitted") {
          await this.host.beforeSubmit(op);
          await harness.submit(store.modelContent(op), { session: op.sessionId, operationId: op.id });
          store.submitted(op.id);
        }
      }
      return store.operation(op.id)?.status === "submitted";
    } finally { this.submitting.delete(op.id); }
  }

  /** The request path: submits a turn in the request that admitted it, then wakes the coordinator, which follows it. */
  async submitDirect(op: Operation): Promise<void> {
    if (await this.submitOwner(op)) await this.host.wake();
  }

  /** The coordinator's stage. One turn that fails does not hold back the others. */
  async drive(): Promise<void> {
    let first: unknown;
    for (const op of this.host.store.pendingOperations()) {
      try { await this.driveOne(op); }
      catch (error) { first ??= error; this.host.driveFailed(error); }
    }
    if (first !== undefined) throw first;
  }

  /**
   * When the stage next needs a run. An admitted turn asks for none: missing credentials do not justify a loop, and an
   * authorization update wakes the coordinator. A running turn is checked slowly while its wait is attached.
   */
  nextDue(now = Date.now()): number | undefined {
    const submitted = this.host.store.pendingOperations().filter(op => op.status === "submitted");
    if (!submitted.length) return undefined;
    return now + (submitted.every(op => this.waits.has(op.id)) ? TURN_CHECK_MS : TURN_RETRY_MS);
  }

  /** Turns whose wait is attached now. */
  following(): string[] { return [...this.waits.keys()]; }

  private async driveOne(op: Operation): Promise<void> {
    const { store, harness } = this.host;
    if (op.background) {
      if (!this.host.backgroundActionable(op)) {
        if (op.status === "submitted") await harness.abort({ session: op.sessionId, operationId: op.id });
        else { store.settle(op.id, "Background review is no longer actionable.", true); return; }
      }
      if (op.status === "admitted" && store.hasForegroundInput()) return;
    }
    if (op.status === "admitted") {
      if (!(await this.host.modelReady())) return;
      // Credential reads yield. An owner edit/cancellation may have invalidated this work meanwhile.
      if (store.operation(op.id)?.status !== "admitted") return;
      if (op.background) {
        if (store.hasForegroundInput()) return;
        if (!this.host.backgroundCurrent(op)) { store.settle(op.id, "Background review is no longer actionable.", true); return; }
        await harness.submit(store.modelContent(op), { session: op.sessionId, operationId: op.id });
        store.submitted(op.id);
      } else if (!(await this.submitOwner(op))) return;
    }
    this.follow(op);
  }

  private follow(op: Operation): void {
    if (this.waits.has(op.id)) return;
    const work = this.result(op).catch(error => {
      this.host.resultFailed(error);
      // The coordinator's slow check would attach a new wait; this does it sooner, and not in a tight loop.
      setTimeout(() => { void this.host.wake().catch(() => undefined); }, TURN_RETRY_MS);
    }).finally(() => { this.waits.delete(op.id); });
    this.waits.set(op.id, work);
    this.host.track(work);
  }

  /** Waits until the model ends the turn, then writes the result and wakes the coordinator to deliver it. */
  private async result(op: Operation): Promise<void> {
    const { store, harness } = this.host;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TURN_WAIT_MS);
      let answer: TurnAnswer;
      try { answer = await harness.wait(op.id, { session: op.sessionId, signal: controller.signal }); }
      catch (error) {
        if (!controller.signal.aborted) throw error;
        // The limit passed and the turn still runs: wait again from here, with no reconciliation in between.
        if (store.operation(op.id)?.status !== "submitted") return;
        continue;
      } finally { clearTimeout(timer); }
      await this.host.finish(op, answer);
      await this.host.wake();
      return;
    }
  }
}

/**
 * Sets a conversation's thinking level when it differs from the one in effect. An unchanged level costs no commit
 * before the turn. Returns whether it was changed.
 */
export async function setThinkingLevel<Context>(
  conversation: { agent(context: Context): Promise<{ readonly thinkingLevel: string }>; configure(change: { thinkingLevel: Effort }, context: Context): Promise<void> },
  level: Effort, context: Context): Promise<boolean> {
  if ((await conversation.agent(context)).thinkingLevel === level) return false;
  await conversation.configure({ thinkingLevel: level }, context);
  return true;
}
