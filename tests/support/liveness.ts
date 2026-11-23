import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { InputError } from "../../src/shared/protocol.js";
import { StateError, type Database } from "../../src/worker/store.js";

/**
 * A deterministic simulation harness for one property of the coordinator's lanes:
 *
 *   Every piece of work in a non-terminal state has a finite next wake that is not "now forever", or a reason the
 *   owner can see.
 *
 * A lane is one subsystem that holds durable work: its stores, the stage that drives it, and the `due` of that stage.
 * The harness runs random sequences of owner actions, outside-party actions, time, and coordinator restarts against a
 * lane. After every step it checks for orphans. At the end of every sequence it lets the lane run alone, with nothing
 * else changing, and checks for spins. Sequences have random lengths, so every prefix of a sequence is a state that
 * some other sequence ends in; the check at the end therefore covers the states in the middle as well.
 */

/** The simulated clock starts here in every sequence. A Monday morning, UTC. */
export const START = Date.parse("2026-03-02T08:00:00Z");
export const SECOND = 1_000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** Wakes in a row with no durable change before a lane is called stuck. */
export const IDLE_WAKES = 50;
/** A jump past every deadline a lane has, so that a poll with a deadline behind it is not called endless. */
const FAR = 30 * DAY;
/** A lane that keeps changing state (a daily schedule) is left alone after this many wakes. */
const RHYTHM_WAKES = 120;
/** Wakes in a row at fixed future times that change nothing, such as a heartbeat, before the lane is left alone. */
const FIXED_WAKES = 30;

export interface Random {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, below). */
  int(below: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}
/** mulberry32: small, fast, and the same on every machine. `Math.random` is never used. */
export function random(seed: number): Random {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return { next, int: below => Math.floor(next() * below), pick: items => items[Math.floor(next() * items.length)]!, chance: probability => next() < probability };
}

export interface Sqlite { sqlite: DatabaseSync; db: Database }
/** `node:sqlite` in memory, with the nested savepoints the stores expect of a Durable Object transaction. */
export function openDatabase(): Sqlite {
  const sqlite = new DatabaseSync(":memory:");
  let depth = 0;
  const db: Database = {
    all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[],
    transaction: <T>(run: () => T): T => {
      const savepoint = `liveness_${depth++}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try { const result = run(); assert.equal(result instanceof Promise, false, "a store transaction must be synchronous"); sqlite.exec(`RELEASE ${savepoint}`); return result; }
      catch (error) { sqlite.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
      finally { depth--; }
    },
  };
  return { sqlite, db };
}

/** The clock of one sequence. It only moves forward. With `timers`, mocked `setTimeout` callbacks fire as it moves. */
export interface Clock {
  now(): number;
  advance(milliseconds: number): void;
}

/** One piece of work that is not finished. `state` is the name the lane's waiting list is written in. */
export interface Item { id: string; state: string }

export interface Action<W> {
  name: string;
  /** How often the action is chosen, relative to the others. Default 1. */
  weight?: number;
  /**
   * Performs the action. A rejected request (`StateError`, `InputError`) is a legal outcome and is ignored, as the
   * real caller would get an error reply. Any other error fails the test.
   */
  run(world: W, random: Random, clock: Clock): void | Promise<void>;
}

/** A state in which work waits on the owner or a named outside party, with what makes the owner able to see it. */
export interface Waiting<W> {
  /** The doc or code that shows this state to the owner, quoted. */
  evidence: string;
  /** An executable form of the evidence, where one is cheap: the card, notice, or status the owner gets. */
  shown?(world: W, item: Item): boolean;
}

/**
 * A poll the lane is allowed to keep: a due time that slides with the clock while the lane waits on something it does
 * not own. `when` says what it waits on. Each one is an exception to "no spin" and is listed in the report.
 */
export interface AllowedPoll<W> { everyAtLeastMs: number; when(world: W): boolean; evidence: string }

export type ViolationKind = "orphan" | "tight-loop" | "endless-poll";
export interface Violation { kind: ViolationKind; states: string[]; detail: string }
/** A violation that is already reduced to a named `todo` test in this file. The simulation steps over it. */
export interface KnownDefect { kind: ViolationKind; state: string | RegExp; test: string }

export interface Lane<W> {
  name: string;
  /** Mocked `setTimeout`, for lanes whose code sets deadlines with real timers. */
  timers?: boolean;
  /** Builds a new world over an empty database. */
  open(sqlite: Sqlite, clock: Clock): W | Promise<W>;
  /** A coordinator restart: new store objects over the same database, then what `onStart` runs for this lane. */
  restart(world: W, clock: Clock): void | Promise<void>;
  /** The lane's stage, run once at the current time, as the coordinator's reconciliation runs it. */
  drive(world: W, clock: Clock): void | Promise<void>;
  /** The lane's stage `due` at the current time. */
  nextDue(world: W, clock: Clock): number | undefined;
  /** Every piece of work that is not in a terminal state. */
  items(world: W, clock: Clock): Item[];
  /** A string that changes exactly when durable state of this lane changes. */
  fingerprint(world: W): string;
  /** States that wait visibly on someone else. Every other state needs a wake. */
  waiting: Record<string, Waiting<W>>;
  polls?: AllowedPoll<W>[];
  known?: KnownDefect[];
  actions: Action<W>[];
  /** Lets background promises of the lane finish. Called after every action and every drive. */
  settle?(world: W): Promise<void>;
  close?(world: W): void;
}

/** Rows of the named tables, as one string. Tables that do not exist yet read as empty. */
export function tables(sqlite: DatabaseSync, names: readonly string[]): string {
  return names.map(name => {
    try { return `${name}=${JSON.stringify(sqlite.prepare(`SELECT * FROM ${name} ORDER BY 1`).all())}`; }
    catch { return `${name}=`; }
  }).join("\n");
}

/** Lets promise chains that are already resolved run to their end. `setImmediate` is never mocked here. */
export async function flush(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await new Promise<void>(resolve => setImmediate(resolve));
}

const matches = (pattern: string | RegExp, state: string) => typeof pattern === "string" ? pattern === state : pattern.test(state);

interface Step { action: number; seed: number }
interface Outcome { violation?: Violation; trace: string[] }
const GENERIC = ["(coordinator wakes at nextDue)", "(time passes)", "(coordinator restarts)"] as const;

/** The first work item that neither has a wake nor waits visibly. */
function orphan<W>(lane: Lane<W>, world: W, clock: Clock): Violation | undefined {
  const due = lane.nextDue(world, clock);
  if (due !== undefined && !Number.isFinite(due)) return { kind: "orphan", states: [], detail: `nextDue returned ${due}` };
  for (const item of lane.items(world, clock)) {
    const waiting = lane.waiting[item.state];
    if (waiting) {
      if (waiting.shown && !waiting.shown(world, item)) return { kind: "orphan", states: [item.state], detail: `${item.id} is in the waiting state "${item.state}", but what should show it to the owner is missing` };
      continue;
    }
    if (due === undefined) return { kind: "orphan", states: [item.state], detail: `${item.id} is "${item.state}": no wake is scheduled and the state is not one the owner can see as waiting` };
  }
  return undefined;
}

/**
 * Runs the lane alone: the clock moves to each `nextDue`, the stage is driven, and nothing else happens. The lane must
 * come to rest (no wake), or keep changing durable state. `IDLE_WAKES` wakes in a row with no durable change are a
 * tight loop when the due time is not in the future, and an endless poll when the due time slides with the clock and
 * even a jump of thirty days ends nothing.
 */
async function quiet<W>(lane: Lane<W>, world: W, clock: Clock, trace: string[], seen?: Set<string>): Promise<Violation | undefined> {
  let idle = 0, tight = 0, sliding = 0, jumped = false, smallest = Infinity;
  for (let wakes = 0; wakes < RHYTHM_WAKES + 2 * IDLE_WAKES; wakes++) {
    for (const item of seen ? lane.items(world, clock) : []) seen!.add(item.state);
    const lost = orphan(lane, world, clock);
    if (lost) return lost;
    const due = lane.nextDue(world, clock);
    if (due === undefined) return undefined;
    const before = lane.fingerprint(world);
    // The clock always advances, as it does between two alarms.
    clock.advance(Math.max(1, due - clock.now()));
    await lane.drive(world, clock);
    await lane.settle?.(world);
    if (lane.fingerprint(world) !== before) { idle = tight = sliding = 0; smallest = Infinity; continue; }
    idle++;
    const first = lane.nextDue(world, clock);
    if (first === undefined) continue;
    if (first <= clock.now()) tight++;
    else {
      // A due time computed as "now plus something" moves when the clock moves and nothing was driven.
      clock.advance(1);
      const second = lane.nextDue(world, clock);
      if (second !== undefined && second > first) { sliding++; smallest = Math.min(smallest, first - (clock.now() - 1)); }
    }
    // Wakes at fixed times that change nothing durable are a rhythm, not a spin.
    if (tight === 0 && sliding === 0 && idle >= FIXED_WAKES) return undefined;
    if (idle < IDLE_WAKES) continue;
    const states = lane.items(world, clock).map(item => item.state);
    if (tight === idle) return { kind: "tight-loop", states, detail: `${idle} drives in a row changed nothing and nextDue stayed at or before now` };
    if (!jumped) { jumped = true; idle = tight = sliding = 0; smallest = Infinity; clock.advance(FAR); trace.push("(thirty days pass)"); continue; }
    if (sliding + tight === idle) {
      if (lane.polls?.some(poll => smallest >= poll.everyAtLeastMs && poll.when(world))) return undefined;
      return { kind: "endless-poll", states, detail: `${idle} wakes in a row changed nothing, also after thirty days; nextDue is always now + ${smallest} ms` };
    }
    // A mix of fixed and sliding times with no change: a rhythm, not a spin.
    return undefined;
  }
  return undefined;
}

async function sequence<W>(t: TestContext, lane: Lane<W>, steps: Step[], seen?: Set<string>): Promise<Outcome> {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: lane.timers ? ["Date", "setTimeout"] : ["Date"], now: START });
  let now = START;
  const clock: Clock = { now: () => now, advance(milliseconds) { now += milliseconds; t.mock.timers.tick(milliseconds); } };
  const sqlite = openDatabase(), trace: string[] = [];
  const world = await lane.open(sqlite, clock);
  try {
    await lane.settle?.(world);
    for (const step of steps) {
      const source = random(step.seed);
      const name = step.action < lane.actions.length ? lane.actions[step.action]!.name : GENERIC[step.action - lane.actions.length]!;
      trace.push(name);
      try {
        if (step.action < lane.actions.length) await lane.actions[step.action]!.run(world, source, clock);
        else if (name === GENERIC[0]) {
          const due = lane.nextDue(world, clock);
          if (due !== undefined) { clock.advance(Math.max(1, due - clock.now())); await lane.drive(world, clock); }
        } else if (name === GENERIC[1]) {
          clock.advance(source.pick([SECOND, 30 * SECOND, 5 * MINUTE, HOUR, 5 * HOUR, 26 * HOUR]));
          await lane.drive(world, clock);
        } else {
          // `Coordinator.onStart` recovers, then wakes: one reconciliation follows every restart.
          await lane.restart(world, clock);
          await lane.drive(world, clock);
        }
      } catch (error) {
        if (!(error instanceof StateError) && !(error instanceof InputError)) throw error;
      }
      await lane.settle?.(world);
      for (const item of seen ? lane.items(world, clock) : []) seen!.add(item.state);
      const lost = orphan(lane, world, clock);
      if (lost) return { violation: lost, trace };
    }
    trace.push("(the lane runs alone)");
    const violation = await quiet(lane, world, clock, trace, seen);
    return violation ? { violation, trace } : { trace };
  } finally {
    await lane.settle?.(world);
    lane.close?.(world);
    sqlite.sqlite.close();
    t.mock.timers.reset();
  }
}

const same = (a: Violation, b: Violation) => a.kind === b.kind && a.states.join() === b.states.join();
const known = <W>(lane: Lane<W>, violation: Violation) => lane.known?.find(defect => defect.kind === violation.kind && violation.states.some(state => matches(defect.state, state)));

/**
 * Runs `sequences` random sequences of at most `maxSteps` steps against the lane. A violation that is not a known
 * defect fails the test, with the seed and the shortest action sequence found that still shows it.
 */
export async function simulate<W>(t: TestContext, lane: Lane<W>, options: { sequences?: number; maxSteps?: number; seed?: number } = {}): Promise<void> {
  const { sequences = 200, maxSteps = 14, seed = 1 } = options;
  const total = lane.actions.reduce((sum, action) => sum + (action.weight ?? 1), 0);
  const reached = new Map<string, number>(), seen = new Set<string>();
  for (let index = 0; index < sequences; index++) {
    const source = random(seed * 1_000_003 + index);
    const steps: Step[] = [];
    for (let length = 1 + source.int(maxSteps); steps.length < length;) {
      // One step in four is a wake, time passing, or a restart; the rest are the lane's own actions.
      if (source.chance(0.25)) { steps.push({ action: lane.actions.length + source.pick([0, 0, 1, 1, 2]), seed: source.int(2 ** 31) }); continue; }
      let pick = source.next() * total, action = 0;
      while (action < lane.actions.length - 1 && (pick -= lane.actions[action]!.weight ?? 1) >= 0) action++;
      steps.push({ action, seed: source.int(2 ** 31) });
    }
    const outcome = await sequence(t, lane, steps, seen);
    if (!outcome.violation) continue;
    const defect = known(lane, outcome.violation);
    if (defect) { reached.set(defect.test, (reached.get(defect.test) ?? 0) + 1); continue; }
    // Shrink: drop one step at a time while the same violation remains.
    let shortest = steps, shown = outcome;
    for (let at = 0; at < shortest.length;) {
      const candidate = shortest.filter((_, position) => position !== at);
      const retry = await sequence(t, lane, candidate);
      if (retry.violation && same(retry.violation, outcome.violation)) { shortest = candidate; shown = retry; } else at++;
    }
    assert.fail(`${lane.name}: ${outcome.violation.kind} (seed ${seed}, sequence ${index}).\n${shown.violation!.detail}\nStates: ${shown.violation!.states.join(", ") || "none"}\nActions:\n${shown.trace.map(step => `  - ${step}`).join("\n")}`);
  }
  t.diagnostic(`${lane.name}: ${sequences} sequences; open states reached: ${[...seen].sort().join(", ") || "none"}`);
  for (const defect of lane.known ?? []) t.diagnostic(`${lane.name}: known defect "${defect.test}" reached in ${reached.get(defect.test) ?? 0} of ${sequences} sequences`);
}

/** Runs one fixed scenario and returns what the two checks find, for the reduced tests. */
export async function scenario<W>(t: TestContext, lane: Lane<W>, run: (world: W, clock: Clock) => void | Promise<void>): Promise<Violation | undefined> {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: lane.timers ? ["Date", "setTimeout"] : ["Date"], now: START });
  let now = START;
  const clock: Clock = { now: () => now, advance(milliseconds) { now += milliseconds; t.mock.timers.tick(milliseconds); } };
  const sqlite = openDatabase();
  const world = await lane.open(sqlite, clock);
  try {
    await run(world, clock);
    await lane.settle?.(world);
    return orphan(lane, world, clock) ?? await quiet(lane, world, clock, []);
  } finally {
    await lane.settle?.(world);
    lane.close?.(world);
    sqlite.sqlite.close();
    t.mock.timers.reset();
  }
}
