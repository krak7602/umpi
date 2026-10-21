import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { classifyModelError, describeModelFailure } from "../src/model/failure.js";
import { FALLBACK_WINDOW_MS, ModelFallback } from "../src/worker/model-fallback.js";
import type { Database } from "../src/worker/store.js";

test("provider errors are classified by cause and credentials are removed from the stored text", () => {
  const limit = classifyModelError('429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}');
  assert.equal(limit.kind, "limit"); assert.match(describeModelFailure(limit), /^Claude rate or usage limit reached \(HTTP 429\): 429/);
  assert.equal(classifyModelError('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}').kind, "overloaded");
  assert.equal(classifyModelError("401 invalid x-api-key").kind, "auth");
  assert.equal(classifyModelError("fetch failed: getaddrinfo ENOTFOUND api.anthropic.com").kind, "network");
  assert.equal(classifyModelError("prompt is too long: 250000 tokens > 200000 maximum").kind, "context");
  assert.equal(classifyModelError(undefined).kind, "other");
  const redacted = classifyModelError("401 Bearer sk-ant-oat01-abcdefghijklmnopqrstuvwxyz rejected; key sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ").detail;
  assert.doesNotMatch(redacted, /abcdefghij|ZZZZZZZZ/);
});

function database(t: TestContext): Database {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  return { all: <T extends object>(query: string, ...bindings: (string | number | null)[]) => sqlite.prepare(query).all(...bindings) as T[], transaction: <T>(run: () => T) => run() };
}

test("the fallback activates for a window only with a valid key, and notifies once per local day", t => {
  let now = Date.parse("2026-10-22T20:00:00Z"), secret: string | undefined;
  const notices: [string, string][] = [];
  const fallback = new ModelFallback(database(t), () => secret, "Asia/Kolkata", (group, text) => notices.push([group, text]), () => now);
  fallback.limited();
  assert.equal(fallback.active(), false); assert.equal(notices.length, 0, "no key: the limit is only recorded");
  secret = "sk-ant-api03-synthetic-fallback-key-0000";
  fallback.limited(); fallback.used(); fallback.used();
  assert.equal(fallback.active(), true); assert.equal(notices.length, 1);
  assert.equal(notices[0]![0], "notice:model-fallback:2026-10-23"); assert.match(notices[0]![1], /until about 02:00/);
  assert.deepEqual({ ...fallback.status() as object, lastLimitedAt: undefined, lastUsedAt: undefined },
    { configured: true, active: true, activeUntil: new Date(now + FALLBACK_WINDOW_MS).toISOString(), lastLimitedAt: undefined, lastUsedAt: undefined, requestsToday: 2 });
  now += FALLBACK_WINDOW_MS;
  assert.equal(fallback.active(), false);
  fallback.limited();
  assert.equal(notices.length, 2, "a later episode notifies again, but the group ID keeps it to one message per day");
  assert.equal(notices[1]![0], notices[0]![0]);
  secret = "not-a-key";
  assert.equal(fallback.active(), false); assert.equal(fallback.key(), undefined);
});
