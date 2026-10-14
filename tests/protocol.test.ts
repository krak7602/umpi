import assert from "node:assert/strict";
import test from "node:test";
import { coordinatorUrl } from "../src/shared/coordinator-url.ts";
import { InputError, MAX_JOB_OUTPUT, parseAssignment, parseCompletion, timestamp } from "../src/shared/protocol.ts";

test("reminder timestamps reject calendar rollover and missing timezones", () => {
  for (const value of ["2026-02-29T10:00:00Z", "2026-04-31T10:00:00Z", "2026-02-31T10:00:00+05:30", "2026-10-11T24:00:00Z", "2026-10-11T10:00:00"]) {
    assert.throws(() => timestamp(value, "reminder time"), InputError);
  }
  assert.equal(Date.parse(timestamp("2028-02-29T23:15:00+05:30", "reminder time")), Date.UTC(2028, 1, 29, 17, 45));
});

test("completion cannot coerce an array into a terminal state or claim unknown success", () => {
  const result = { executorId: "mac", jobId: "job-1", status: "succeeded", exitCode: 0, output: "done", truncated: false, finishedAt: "2026-10-11T10:00:00Z" };
  assert.throws(() => parseCompletion({ ...result, status: ["succeeded"] }), InputError);
  assert.throws(() => parseCompletion({ ...result, exitCode: null }), InputError);
  assert.throws(() => parseCompletion({ ...result, status: "uncertain" }), InputError);
  assert.equal(parseCompletion({ ...result, status: "uncertain", exitCode: null }).status, "uncertain");
  // A process can handle a timeout's SIGTERM and exit zero without meeting the deadline.
  assert.equal(parseCompletion({ ...result, status: "failed" }).status, "failed");
  assert.throws(() => parseCompletion({ ...result, output: "x".repeat(MAX_JOB_OUTPUT + 1) }), InputError);
});

test("assignments reject unbounded execution and embedded null commands before spawn", () => {
  const assignment = { jobId: "job-1", command: "printf ok", cwd: "/tmp/work", timeoutMs: 1_000, createdAt: "2026-10-11T10:00:00Z" };
  assert.throws(() => parseAssignment({ ...assignment, timeoutMs: 0 }), InputError);
  assert.throws(() => parseAssignment({ ...assignment, timeoutMs: 3_600_001 }), InputError);
  assert.throws(() => parseAssignment({ ...assignment, command: "printf ok\0echo bad" }), InputError);
  assert.throws(() => parseAssignment({ ...assignment, jobId: "../../other-job" }), InputError);
});

test("coordinator credentials cannot be sent over remote HTTP or to an ambiguous origin", () => {
  for (const value of ["http://example.com", "http://localhost.example.com", "https://user:secret@example.com", "https://example.com/private", "https://example.com?token=secret", "https://example.com#fragment", "file:///tmp/server"]) {
    assert.throws(() => coordinatorUrl(value), InputError);
  }
  assert.equal(coordinatorUrl("http://127.0.0.1:8787").origin, "http://127.0.0.1:8787");
  assert.equal(coordinatorUrl("http://[::1]:8787").origin, "http://[::1]:8787");
  assert.equal(coordinatorUrl("https://assistant.example.com").origin, "https://assistant.example.com");
});
