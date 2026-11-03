import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { InputError, boundedText, record } from "../shared/protocol.js";
import { StateError, type Database } from "./store.js";

/**
 * T3 Code machines, reached through T3 Connect. Each machine is added by its MCP address (T3 Code: Settings →
 * Environments → Copy MCP URL). Umpi registers itself there with OAuth (dynamic registration and PKCE); the owner
 * approves it on the machine with a pairing code and chooses the access level. T3 issues no refresh token: access
 * lasts about 30 days, then the owner approves again. Umpi only reads: projects, threads, and their messages.
 */
export type T3Status = "pending" | "connected" | "expired" | "failed";
interface MachineRecord {
  id: string;
  label: string;
  url: string;
  status: T3Status;
  addedAt: string;
  connectedAt?: string;
  expiresAt?: string;
  error?: string;
  environment?: { id: string; label: string };
  // Approval in progress: the address the approval returns to, its state, and the PKCE verifier.
  redirectUrl?: string;
  state?: string;
  stateAt?: string;
  verifier?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}
/** What the app and the status show: no tokens, no state. */
export interface T3Machine {
  id: string; label: string; host: string; status: T3Status; addedAt: string;
  connectedAt?: string; expiresAt?: string; error?: string; environmentLabel?: string;
}
export interface T3Thread {
  threadId: string; title: string; status: string; projectId?: string; project?: string; settled: boolean;
  createdAt?: string; updatedAt?: string; model?: string; branch?: string; subagent?: boolean; pullRequests?: number;
  /** From a search: the matching text. */
  snippet?: string;
}
/** One pending question from an agent: what it asks, and the choices it offers. Answers are keyed by question ID. */
export interface T3Question {
  requestId: string;
  questions: { id: string; header?: string; question: string; options: { label: string; description?: string; value?: string }[]; multiSelect?: boolean; allowCustomAnswer?: boolean }[];
}
export interface T3Message { position: number; type: string; by?: string; text: string; truncated?: boolean; at?: string }

/** What Umpi can do to a machine's threads. */
export type T3Action =
  | { kind: "send"; threadId: string; message: string; mode?: "auto" | "queue" | "steer" | "restart" }
  | { kind: "start"; title: string; message: string; project?: string; projectId?: string; worktree?: boolean; branch?: string; baseRef?: string; plan?: boolean }
  | { kind: "stop"; threadId: string; reason?: string; whole?: boolean }
  | { kind: "answer"; threadId: string; requestId: string; answers: Record<string, unknown> };

export const T3_MAX_MACHINES = 6;
const APPROVAL_MS = 15 * 60_000;
const REQUEST_MS = 20_000;
const CALLBACK_PATH = "/t3/callback";

export class T3Error extends Error {}

function view(row: MachineRecord): T3Machine {
  return { id: row.id, label: row.label, host: new URL(row.url).host, status: row.status, addedAt: row.addedAt,
    ...(row.connectedAt ? { connectedAt: row.connectedAt } : {}), ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    ...(row.error ? { error: row.error } : {}), ...(row.environment ? { environmentLabel: row.environment.label } : {}) };
}

/** The machine's MCP address: https (or http on this computer, for a local copy), ending in /mcp. */
export function machineUrl(value: unknown): string {
  const text = boundedText(value, 500, "MCP address").trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new InputError("Paste the machine's MCP address, such as https://…/mcp"); }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new InputError("The MCP address must start with https://");
  if (url.username || url.password || url.hash) throw new InputError("The MCP address cannot hold a user name, password, or #fragment");
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/mcp";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/mcp")) throw new InputError("The MCP address ends in /mcp (T3 Code: Settings → Environments → Copy MCP URL)");
  return url.href;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The OAuth client the MCP SDK drives; it reads and writes one machine record, which the store then saves. */
class MachineAuth implements OAuthClientProvider {
  authorizationUrl?: URL;
  constructor(private readonly row: MachineRecord) {}
  get redirectUrl(): string | undefined { return this.row.redirectUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Umpi", redirect_uris: this.row.redirectUrl ? [this.row.redirectUrl] : [], grant_types: ["authorization_code"],
      response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state(): string { if (!this.row.state) throw new T3Error("No approval is in progress"); return this.row.state; }
  clientInformation(): OAuthClientInformationMixed | undefined { return this.row.client; }
  saveClientInformation(information: OAuthClientInformationMixed): void { this.row.client = information; }
  tokens(): OAuthTokens | undefined { return this.row.tokens; }
  saveTokens(tokens: OAuthTokens): void { this.row.tokens = tokens; }
  redirectToAuthorization(url: URL): void { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string): void { this.row.verifier = verifier; }
  codeVerifier(): string { if (!this.row.verifier) throw new T3Error("No approval is in progress"); return this.row.verifier; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") delete this.row.client;
    if (scope === "all" || scope === "tokens") delete this.row.tokens;
    if (scope === "all" || scope === "verifier") delete this.row.verifier;
  }
}

type Fetcher = typeof fetch;
type Session = { call(name: string, args: Record<string, unknown>): Promise<unknown> };

export class T3CodeStore {
  constructor(private readonly db: Database, private readonly fetcher: Fetcher = (input, init) => fetch(input, init), private readonly now = () => Date.now()) {
    db.all("CREATE TABLE IF NOT EXISTS umpi_t3_machines (id TEXT PRIMARY KEY, state TEXT, data TEXT NOT NULL)");
  }

  private rows(): MachineRecord[] {
    return this.db.all<{ data: string }>("SELECT data FROM umpi_t3_machines").map(row => JSON.parse(row.data) as MachineRecord)
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }
  private row(id: string): MachineRecord {
    const row = this.db.all<{ data: string }>("SELECT data FROM umpi_t3_machines WHERE id=?", id)[0];
    if (!row) throw new StateError(404, "No T3 Code machine with that ID");
    return JSON.parse(row.data) as MachineRecord;
  }
  private save(row: MachineRecord): void {
    this.db.all("INSERT INTO umpi_t3_machines VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, data=excluded.data", row.id, row.state ?? null, JSON.stringify(row));
  }
  /** Marks a machine whose access ran out, so the app asks for approval again. */
  private expire(row: MachineRecord): MachineRecord {
    if (row.status === "connected" && row.expiresAt && Date.parse(row.expiresAt) <= this.now()) {
      row.status = "expired"; delete row.tokens; row.error = "Access ended after 30 days. Approve Umpi again on the machine.";
      this.save(row);
    }
    return row;
  }

  list(): T3Machine[] { return this.rows().map(row => view(this.expire(row))); }
  connected(): T3Machine[] { return this.list().filter(machine => machine.status === "connected"); }

  /** A fetch that gives up on a machine that does not answer, such as a closed laptop behind T3 Connect. */
  private timed(): Fetcher {
    return (input, init) => this.fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS) });
  }

  /** Adds a machine and starts its approval; the owner opens the returned address and enters a pairing code there. */
  async add(input: unknown, origin: string): Promise<{ machine: T3Machine; authorizeUrl: string }> {
    const body = record(input);
    if (Object.keys(body).some(key => !["url", "label"].includes(key))) throw new InputError("Unknown machine field");
    const url = machineUrl(body.url);
    const rows = this.rows();
    const existing = rows.find(row => row.url === url);
    if (existing) return this.connect(existing.id, origin);
    if (rows.length >= T3_MAX_MACHINES) throw new InputError(`At most ${T3_MAX_MACHINES} machines can be added`);
    const label = body.label === undefined || body.label === "" ? new URL(url).host : boundedText(body.label, 60, "machine name").trim();
    const row: MachineRecord = { id: `t3-${crypto.randomUUID()}`, label, url, status: "pending", addedAt: new Date(this.now()).toISOString() };
    this.save(row);
    return this.connect(row.id, origin);
  }

  /** Starts (or restarts) approval. Earlier access to this machine stays until the new approval completes. */
  async connect(id: string, origin: string): Promise<{ machine: T3Machine; authorizeUrl: string }> {
    const row = this.row(id);
    const redirectUrl = new URL(CALLBACK_PATH, origin).href;
    if (!redirectUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(redirectUrl)) throw new InputError("Umpi must be reached over HTTPS to approve a machine");
    // A registration made for another address is not reused; T3 Code's client IDs are signed, so registering again is free.
    const registered = row.client && "redirect_uris" in row.client ? (row.client as { redirect_uris?: string[] }).redirect_uris : undefined;
    if (row.redirectUrl !== redirectUrl || !registered?.includes(redirectUrl)) delete row.client;
    const draft: MachineRecord = { ...row, redirectUrl, state: randomToken(), stateAt: new Date(this.now()).toISOString() };
    delete draft.tokens; delete draft.verifier;
    const provider = new MachineAuth(draft);
    let result: string;
    try { result = await auth(provider, { serverUrl: row.url, fetchFn: this.timed() }); }
    catch (error) {
      row.error = `Approval could not start: ${reason(error)}`;
      if (row.status === "pending") row.status = "failed";
      this.save(row);
      throw new StateError(502, row.error);
    }
    if (result !== "REDIRECT" || !provider.authorizationUrl) throw new StateError(502, "The machine did not ask for approval");
    // Keep the current tokens (if any) until the new ones arrive; only the approval fields change.
    const saved: MachineRecord = { ...row, redirectUrl, state: draft.state!, stateAt: draft.stateAt!, verifier: draft.verifier!, ...(draft.client ? { client: draft.client } : {}) };
    if (!draft.client) delete saved.client;
    if (saved.status !== "connected") { saved.status = "pending"; delete saved.error; }
    this.save(saved);
    return { machine: view(saved), authorizeUrl: provider.authorizationUrl.href };
  }

  /** Finishes approval when the machine returns the owner's browser to Umpi with a code. */
  async finish(state: string, code: string | undefined, error: string | undefined): Promise<{ ok: boolean; label: string; message: string }> {
    const found = this.db.all<{ data: string }>("SELECT data FROM umpi_t3_machines WHERE state=?", state)[0];
    if (!found) return { ok: false, label: "T3 Code", message: "This approval link is not current. Start again from Umpi." };
    const row = JSON.parse(found.data) as MachineRecord;
    const clear = () => { delete row.state; delete row.stateAt; delete row.verifier; };
    if (!row.stateAt || this.now() - Date.parse(row.stateAt) > APPROVAL_MS) {
      clear(); this.save(row);
      return { ok: false, label: row.label, message: "This approval took longer than 15 minutes. Start again from Umpi." };
    }
    if (error || !code) {
      clear();
      if (row.status !== "connected") { row.status = "failed"; row.error = error === "access_denied" ? "The approval was declined." : `The machine did not approve Umpi${error ? ` (${error.slice(0, 60)})` : ""}.`; }
      this.save(row);
      return { ok: false, label: row.label, message: row.error ?? "The machine did not approve Umpi." };
    }
    const { tokens: _previous, ...draft }: MachineRecord = { ...row };
    const provider = new MachineAuth(draft);
    const issued = () => provider.tokens();
    try {
      const result = await auth(provider, { serverUrl: row.url, authorizationCode: code, fetchFn: this.timed() });
      if (result !== "AUTHORIZED" || !issued()?.access_token) throw new T3Error("no access was issued");
    } catch (failure) {
      clear();
      if (row.status !== "connected") { row.status = "failed"; row.error = `Approval could not finish: ${reason(failure)}`; }
      this.save(row);
      return { ok: false, label: row.label, message: `Approval could not finish: ${reason(failure)}` };
    }
    const seconds = typeof issued()?.expires_in === "number" ? issued()!.expires_in! : 30 * 86_400;
    const connected: MachineRecord = { ...draft, status: "connected", connectedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + seconds * 1000).toISOString() };
    delete connected.state; delete connected.stateAt; delete connected.verifier; delete connected.error;
    this.save(connected);
    // The machine's own name is a better label than its address.
    try {
      const environment = record(await this.session(connected.id, session => session.call("t3_environment_read", {})));
      if (typeof environment.environmentId === "string" && typeof environment.label === "string") {
        const latest = this.row(connected.id);
        latest.environment = { id: environment.environmentId.slice(0, 100), label: environment.label.slice(0, 60) };
        if (latest.label === new URL(latest.url).host) latest.label = latest.environment.label;
        this.save(latest);
        return { ok: true, label: latest.label, message: "Umpi can now read this machine's T3 Code threads." };
      }
    } catch { /* Connected anyway; the name can come later. */ }
    return { ok: true, label: connected.label, message: "Umpi can now read this machine's T3 Code threads." };
  }

  rename(id: string, label: unknown): T3Machine {
    const row = this.row(id); row.label = boundedText(label, 60, "machine name").trim(); this.save(row); return view(row);
  }
  remove(id: string): { removed: true } {
    this.row(id); this.db.all("DELETE FROM umpi_t3_machines WHERE id=?", id); return { removed: true };
  }

  /** One MCP session with a connected machine: open, run the calls, close. A rejected token marks it expired. */
  async session<T>(id: string, work: (session: Session) => Promise<T>): Promise<T> {
    const row = this.expire(this.row(id));
    if (row.status !== "connected" || !row.tokens?.access_token) {
      throw new T3Error(row.status === "pending" ? `${row.label} is waiting for approval on the machine.` : `${row.label} needs approval again in the Umpi app (Settings → T3 Code).`);
    }
    const token = row.tokens.access_token;
    const transport = new StreamableHTTPClientTransport(new URL(row.url), { fetch: this.timed(), requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "Umpi", version: "1.0.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
    try {
      await client.connect(transport);
      return await work({
        call: async (name, args) => {
          const result = await client.callTool({ name, arguments: args });
          const text = Array.isArray(result.content) ? result.content.flatMap(part => part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? [String((part as { text?: unknown }).text ?? "")] : []).join("\n") : "";
          if (result.isError) throw new T3Error(text.slice(0, 300) || `${name} failed`);
          if (result.structuredContent !== undefined) return result.structuredContent;
          try { return JSON.parse(text); } catch { return text; }
        },
      });
    } catch (error) {
      if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
        const latest = this.row(id);
        if (latest.tokens?.access_token === token) {
          latest.status = "expired"; delete latest.tokens;
          latest.error = error.code === 401 ? "The machine no longer accepts Umpi's access. Approve Umpi again." : "Umpi's access level on this machine does not allow this.";
          this.save(latest);
        }
        throw new T3Error(`${row.label}: ${latest.error ?? "access was refused"}`);
      }
      if (error instanceof T3Error) throw error;
      throw new T3Error(`${row.label} did not answer: ${reason(error)}`);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }

  /** Finds a connected machine by ID or name; with no name, the only connected machine. */
  pick(machine: unknown): T3Machine {
    const connected = this.connected();
    if (machine === undefined || machine === null || machine === "") {
      if (connected.length === 1) return connected[0]!;
      if (!connected.length) throw new T3Error(this.rows().length ? "No T3 Code machine is connected now; the owner can approve Umpi again in the app (Settings → T3 Code)." : "No T3 Code machine is added yet; the owner adds one in the app (Settings → T3 Code).");
      throw new T3Error(`Name the machine: ${connected.map(item => item.label).join(", ")}`);
    }
    const name = String(machine).trim().toLowerCase();
    const found = connected.find(item => item.id === machine || item.label.toLowerCase() === name || item.environmentLabel?.toLowerCase() === name)
      ?? connected.find(item => item.label.toLowerCase().includes(name));
    if (!found) throw new T3Error(`No connected T3 Code machine called "${String(machine).slice(0, 60)}". Connected: ${connected.map(item => item.label).join(", ") || "none"}`);
    return found;
  }

  /** Recent threads, newest first, with project names. */
  async threads(id: string, options: { limit?: number; cursor?: number; statuses?: string[]; titleContains?: string; settled?: boolean; projectId?: string } = {}): Promise<{ threads: T3Thread[]; nextCursor?: number; total?: number }> {
    return this.session(id, async session => {
      const [projects, list] = [await session.call("t3_project_list", { limit: 100 }), await session.call("t3_thread_list", {
        ...(options.projectId ? { projectId: options.projectId } : { allProjects: true }), limit: options.limit ?? 20,
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}), ...(options.statuses?.length ? { statuses: options.statuses } : {}),
        ...(options.titleContains ? { titleContains: options.titleContains } : {}), ...(options.settled !== undefined ? { settled: options.settled } : {}) })];
      const names = projectNames(projects);
      const body = record(list);
      return { threads: (Array.isArray(body.threads) ? body.threads : []).map(item => thread(item, names)).filter((item): item is T3Thread => !!item),
        ...(typeof body.nextCursor === "number" ? { nextCursor: body.nextCursor } : {}), ...(typeof body.total === "number" ? { total: body.total } : {}) };
    });
  }

  /** Searches thread titles, branches, projects, and message text. */
  async search(id: string, query: string, limit = 10): Promise<T3Thread[]> {
    return this.session(id, async session => {
      const projects = projectNames(await session.call("t3_project_list", { limit: 100 }));
      const body = record(await session.call("t3_thread_search", { query, limit }));
      const found = Array.isArray(body.matches) ? body.matches : Array.isArray(body.threads) ? body.threads : [];
      return found.map(item => thread(item, projects)).filter((item): item is T3Thread => !!item);
    });
  }

  /**
   * A thread's messages. `latest` reads the end of the thread: positions count every timeline item (tools, plans,
   * messages), so it reads from a window before the end to the end, keeps the last `limit` messages, and widens the
   * window when it holds too few.
   */
  async read(id: string, threadId: string, options: { latest?: boolean; afterPosition?: number; limit?: number; maxChars?: number } = {}): Promise<{ thread?: T3Thread; messages: T3Message[]; nextPosition?: number; hasMore: boolean }> {
    const limit = options.limit ?? 30, maxChars = options.maxChars ?? 4_000;
    return this.session(id, async session => {
      const read = async (afterPosition: number | undefined, count: number) => record(await session.call("t3_thread_read", { threadId, view: "messages", limit: count, maxCharsPerItem: maxChars, runLimit: 1,
        ...(afterPosition !== undefined ? { afterPosition } : {}) }));
      const messages = (body: Record<string, unknown>) => (Array.isArray(body.items) ? body.items : []).map(message).filter((item): item is T3Message => !!item);
      if (!options.latest) {
        const body = await read(options.afterPosition, limit);
        return { ...(body.thread ? { thread: thread(body.thread, new Map()) } : {}), messages: messages(body),
          ...(typeof body.nextPosition === "number" ? { nextPosition: body.nextPosition } : {}), hasMore: body.hasMore === true };
      }
      const head = await read(undefined, 1);
      const count = Number(record(head.thread).itemCount) || 0;
      let kept: T3Message[] = [], last = head;
      for (const window of [400, 4_000, Number.POSITIVE_INFINITY]) {
        const start = count > window ? count - window - 1 : undefined;
        const found: T3Message[] = [];
        let after = start;
        for (let page = 0; page < 12; page++) {
          last = await read(after, 100);
          found.push(...messages(last));
          if (last.hasMore !== true || typeof last.nextPosition !== "number") break;
          after = last.nextPosition;
        }
        kept = found.slice(-limit);
        if (kept.length >= Math.min(6, limit) || start === undefined) break;
      }
      return { ...(head.thread ? { thread: thread(head.thread, new Map()) } : {}), messages: kept,
        ...(typeof last.nextPosition === "number" ? { nextPosition: last.nextPosition } : {}), hasMore: false };
    });
  }

  /** Projects on a machine: id and name. */
  async projects(id: string): Promise<{ id: string; name: string }[]> {
    return this.session(id, async session => [...projectNames(await session.call("t3_project_list", { limit: 100 })).entries()].map(([projectId, name]) => ({ id: projectId, name })));
  }

  /**
   * One action on a machine's threads. `requestId` makes it idempotent: T3 Code returns the earlier result for a
   * repeated request instead of acting twice.
   */
  async act(id: string, action: T3Action, requestId: string): Promise<unknown> {
    const clientRequestId = requestId.slice(0, 100);
    return this.session(id, async session => {
      switch (action.kind) {
        case "send":
          return session.call("t3_thread_send", { threadId: action.threadId, message: action.message, mode: action.mode ?? "auto", clientRequestId });
        case "stop":
          return session.call("t3_thread_interrupt", { threadId: action.threadId, ...(action.reason ? { reason: action.reason } : {}), ...(action.whole === false ? {} : { stop: true }), clientRequestId });
        case "answer":
          return session.call("t3_pending_request", { action: "respond", threadId: action.threadId, requestId: action.requestId, answers: action.answers });
        case "start": {
          let projectId = action.projectId;
          if (!projectId && action.project) {
            const projects = [...projectNames(await session.call("t3_project_list", { limit: 100 })).entries()];
            const wanted = action.project.trim().toLowerCase();
            const found = projects.find(([, name]) => name.toLowerCase() === wanted) ?? projects.find(([, name]) => name.toLowerCase().includes(wanted));
            if (!found) throw new T3Error(`No project called "${action.project.slice(0, 60)}". Projects: ${projects.map(([, name]) => name).join(", ") || "none"}`);
            projectId = found[0];
          }
          const workspace = action.branch || action.worktree ? { workspaceStrategy: { type: "worktree", ...(action.branch ? { branch: action.branch } : {}), ...(action.baseRef ? { baseRef: action.baseRef } : {}) } } : {};
          const launched = record(await session.call("t3_thread_launch", { title: action.title, message: action.message, clientRequestId,
            ...(projectId ? { projectId } : { scratch: true }), ...workspace, ...(action.plan ? { interactionMode: "plan" } : {}) }));
          const created = Array.isArray(launched.threads) && launched.threads.length ? record(launched.threads[0]) : launched;
          return { threadId: created.threadId, title: action.title, ...(typeof created.status === "string" ? { status: created.status } : {}), ...(typeof created.model === "string" ? { model: created.model } : {}) };
        }
      }
    });
  }

  /** Questions an agent is waiting on in a thread, with their choices. Permission requests are answered in T3 Code. */
  async questions(id: string, threadId: string): Promise<{ requests: T3Question[]; note?: string }> {
    return this.session(id, async session => {
      const list = record(await session.call("t3_pending_request", { action: "list", threadId }));
      const ids = (Array.isArray(list.requestIds) ? list.requestIds : []).map(String).filter(Boolean).slice(0, 5);
      const requests = (await Promise.all(ids.map(requestId => session.call("t3_pending_request", { action: "read", threadId, requestId })))).map(question).filter((item): item is T3Question => !!item);
      return { requests, ...(requests.length ? {} : { note: "Nothing is waiting for an answer. Permission requests (approve a command or edit) are answered in T3 Code itself." }) };
    });
  }

  /** Every connected machine's recent threads, read in parallel; a machine that does not answer shows its problem. */
  async overview(limit = 15): Promise<{ machines: (T3Machine & { threads?: T3Thread[]; problem?: string })[] }> {
    const machines = this.list();
    return { machines: await Promise.all(machines.map(async machine => {
      if (machine.status !== "connected") return machine;
      try { return { ...machine, threads: (await this.threads(machine.id, { limit })).threads }; }
      catch (error) { const latest = this.list().find(item => item.id === machine.id) ?? machine; return { ...latest, problem: error instanceof Error ? error.message : "The machine did not answer." }; }
    })) };
  }

  status(): { machines: number; connected: number; pending: number; expired: number } {
    const machines = this.list();
    return { machines: machines.length, connected: machines.filter(item => item.status === "connected").length,
      pending: machines.filter(item => item.status === "pending").length, expired: machines.filter(item => item.status === "expired" || item.status === "failed").length };
  }
}

function reason(error: unknown): string {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "no answer within 20 seconds";
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, 200) || "unknown error";
}
function text(value: unknown, limit: number): string | undefined { return typeof value === "string" && value ? value.slice(0, limit) : undefined; }
function projectNames(value: unknown): Map<string, string> {
  const body = record(value);
  const projects = Array.isArray(body.projects) ? body.projects : [];
  return new Map(projects.flatMap(item => {
    const project = record(item);
    const id = text(project.projectId ?? project.id, 100), name = text(project.title ?? project.name ?? project.label, 100);
    return id && name ? [[id, name] as [string, string]] : [];
  }));
}
function thread(value: unknown, projects: Map<string, string>): T3Thread | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const threadId = text(item.threadId, 100);
  if (!threadId) return undefined;
  const projectId = text(item.projectId, 100);
  const project = projectId ? projects.get(projectId) : undefined;
  return { threadId, title: text(item.title, 200) ?? "Untitled", status: text(item.status, 30) ?? "unknown", settled: item.settled === true,
    ...(projectId ? { projectId } : {}), ...(project ? { project } : {}),
    ...(text(item.createdAt, 40) ? { createdAt: text(item.createdAt, 40)! } : {}), ...(text(item.updatedAt, 40) ? { updatedAt: text(item.updatedAt, 40)! } : {}),
    ...(text(item.model, 80) ? { model: text(item.model, 80)! } : {}), ...(text(item.branch, 200) ? { branch: text(item.branch, 200)! } : {}),
    ...(item.parentThreadId ? { subagent: true } : {}), ...(Array.isArray(item.pullRequests) && item.pullRequests.length ? { pullRequests: item.pullRequests.length } : {}),
    ...(text(item.snippet, 400) ? { snippet: text(item.snippet, 400)! } : {}),
    ...(!text(item.updatedAt, 40) && text(item.messageCreatedAt, 40) ? { updatedAt: text(item.messageCreatedAt, 40)! } : {}) };
}
function question(value: unknown): T3Question | undefined {
  const body = record(value);
  const requestId = text(body.requestId, 200);
  if (!requestId || !Array.isArray(body.questions)) return undefined;
  return { requestId, questions: body.questions.slice(0, 6).flatMap(item => {
    const entry = record(item);
    const id = text(entry.id, 200), asked = text(entry.question, 2_000);
    if (!id || !asked) return [];
    return [{ id, question: asked, ...(text(entry.header, 120) ? { header: text(entry.header, 120)! } : {}),
      options: (Array.isArray(entry.options) ? entry.options : []).slice(0, 8).flatMap(option => {
        const choice = record(option); const label = text(choice.label, 200);
        return label ? [{ label, ...(text(choice.description, 400) ? { description: text(choice.description, 400)! } : {}), ...(text(choice.value, 200) ? { value: text(choice.value, 200)! } : {}) }] : [];
      }),
      ...(entry.multiSelect === true ? { multiSelect: true } : {}), ...(entry.allowCustomAnswer === true ? { allowCustomAnswer: true } : {}) }];
  }) };
}
function message(value: unknown): T3Message | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const body = typeof item.text === "string" ? item.text : "";
  if (typeof item.position !== "number" || !body.trim()) return undefined;
  return { position: item.position, type: text(item.type, 40) ?? "message", text: body,
    ...(text(item.createdBy, 20) ? { by: text(item.createdBy, 20)! } : {}), ...(item.textTruncated === true ? { truncated: true } : {}),
    ...(text(item.updatedAt, 40) ? { at: text(item.updatedAt, 40)! } : {}) };
}

const STATUSES = ["idle", "preparing", "queued", "starting", "running", "waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back"] as const;

/** Umpi's read-only view of the owner's T3 Code threads. */
export function t3CodeTools(store: T3CodeStore): ToolRegistration[] {
  const result = async (run: () => Promise<unknown>): Promise<ToolExecutionResult> => {
    try { return { content: [{ type: "text", text: JSON.stringify(await run()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof T3Error || error instanceof InputError || error instanceof StateError ? error.message : "T3 Code could not be read." }] }; }
  };
  const machine = Type.Optional(Type.String({ maxLength: 100, description: "Machine name or ID; needed only when more than one is connected" }));
  return [
    defineTool({ name: "t3_code_threads", description: "List the owner's T3 Code coding threads (agent sessions on their machines), newest first, with status (running, waiting, completed, failed, …), project, and branch. Use it when the owner asks what their coding agents are doing, what finished, or what waits on them. With no machine, lists every connected machine. Read-only.",
      parameters: Type.Object({ machine, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), cursor: Type.Optional(Type.Integer({ minimum: 0 })),
        statuses: Type.Optional(Type.Array(Type.Union(STATUSES.map(status => Type.Literal(status))), { maxItems: 10 })),
        titleContains: Type.Optional(Type.String({ maxLength: 100 })), settled: Type.Optional(Type.Boolean({ description: "false: only threads not yet settled (not marked done)" })) }, { additionalProperties: false }),
      replay: "safe",
      async execute(input) {
        return result(async () => {
          const body = record(input);
          const options = { limit: typeof body.limit === "number" ? body.limit : 15, ...(typeof body.cursor === "number" ? { cursor: body.cursor } : {}),
            ...(Array.isArray(body.statuses) ? { statuses: body.statuses.map(String) } : {}), ...(typeof body.titleContains === "string" && body.titleContains ? { titleContains: body.titleContains } : {}),
            ...(typeof body.settled === "boolean" ? { settled: body.settled } : {}) };
          const machines = body.machine ? [store.pick(body.machine)] : store.connected();
          if (!machines.length) store.pick(undefined);
          return { machines: await Promise.all(machines.map(async item => {
            try { return { machine: item.label, ...(await store.threads(item.id, options)) }; }
            catch (error) { return { machine: item.label, problem: error instanceof Error ? error.message : "did not answer" }; }
          })) };
        });
      } }),
    defineTool({ name: "t3_code_read_thread", description: "Read a T3 Code thread's user and assistant messages, by threadId from t3_code_threads or t3_code_search. By default reads the latest messages; with from \"start\" reads from the beginning, then page with afterPosition = nextPosition. Read-only.",
      parameters: Type.Object({ threadId: Type.String({ maxLength: 100 }), machine, from: Type.Optional(Type.Union([Type.Literal("latest"), Type.Literal("start")])),
        afterPosition: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        maxCharsPerMessage: Type.Optional(Type.Integer({ minimum: 200, maximum: 12_000 })) }, { additionalProperties: false }),
      replay: "safe",
      async execute(input) {
        return result(async () => {
          const body = record(input);
          const item = store.pick(body.machine);
          return { machine: item.label, ...(await store.read(item.id, boundedText(body.threadId, 100, "thread ID"), {
            latest: body.afterPosition === undefined && body.from !== "start", ...(typeof body.afterPosition === "number" ? { afterPosition: body.afterPosition } : {}),
            limit: typeof body.limit === "number" ? body.limit : 20, maxChars: typeof body.maxCharsPerMessage === "number" ? body.maxCharsPerMessage : 3_000 })) };
        });
      } }),
    defineTool({ name: "t3_code_search", description: "Search the owner's T3 Code threads by title, branch, PR, project, then message text. With no machine, searches every connected machine. Read-only.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), machine, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }, { additionalProperties: false }),
      replay: "safe",
      async execute(input) {
        return result(async () => {
          const body = record(input);
          const query = boundedText(body.query, 200, "search");
          const machines = body.machine ? [store.pick(body.machine)] : store.connected();
          if (!machines.length) store.pick(undefined);
          return { machines: await Promise.all(machines.map(async item => {
            try { return { machine: item.label, threads: await store.search(item.id, query, typeof body.limit === "number" ? body.limit : 10) }; }
            catch (error) { return { machine: item.label, problem: error instanceof Error ? error.message : "did not answer" }; }
          })) };
        });
      } }),
  ];
}

const escape = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
/** The page the owner's browser lands on after approving (or declining) on the machine. */
export function t3CallbackPage(result: { ok: boolean; label: string; message: string }): Response {
  const title = result.ok ? `Connected to ${result.label}` : "Not connected";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} — Umpi</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;display:grid;place-items:center;min-height:100vh;background:Canvas;color:CanvasText}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.4rem}p{color:GrayText;line-height:1.5}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(result.message)}</p><p>You can close this page and return to Umpi.</p></main></body></html>`;
  return new Response(html, { status: result.ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}
export const T3_CALLBACK_PATH = CALLBACK_PATH;
