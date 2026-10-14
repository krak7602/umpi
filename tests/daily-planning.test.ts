import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeDailyPlan, nextPlanningTime, planningDay, planningDayBounds, shiftPlanningDay,
  type AppliedPlanEntry, type PlanEntry,
} from "../src/shared/daily-planning.ts";

const day = "2026-10-12";
const template = "# {{date:MMM Do, YYYY}}\n\n## Plan\n\n### Schedule\n\n### Tasks\n\n## Done / changed\n\n## Notes\n\n## Links\n";
const first: PlanEntry = { id: "task:opaque-1", section: "tasks", text: "Prepare the synthetic fixture" };

function merge(current: string | null, previous: AppliedPlanEntry[] = [], entries: PlanEntry[] = [first], coverage: string[] = []) {
  return mergeDailyPlan({ day, current, template, previous, patch: { entries, coverage } });
}

test("new notes render the current template, while existing titles and layout stay unchanged", () => {
  const result = merge(null);
  assert.ok(result.text.startsWith("# Oct 12th, 2026\n"));
  assert.equal(result.applied.length, 1);
  assert.ok(result.text.includes(result.applied[0]!.line));
  const newerTemplate = "# {{date:YYYY-MM-DD}}\n\n## Plan\n\n### Tasks\n\n## Notes\nCurrent template field\n";
  const created = mergeDailyPlan({ day, current: null, template: newerTemplate, previous: [], patch: { entries: [first], coverage: [] } });
  assert.ok(created.text.startsWith(`# ${day}\n`));
  assert.ok(created.text.includes("Current template field"));
  const rerun = mergeDailyPlan({ day, current: result.text, template: "{{unsupported}}", previous: result.applied, patch: { entries: [first], coverage: [] } });
  assert.equal(rerun.text, result.text);
});

test("same identity rewording updates only its unchanged owned line and is idempotent", () => {
  const initial = merge(null);
  const entry = { ...first, text: "Review the synthetic fixture instead" };
  const updated = merge(initial.text, initial.applied, [entry]);
  assert.equal(updated.applied.length, 1);
  assert.notEqual(updated.applied[0]!.line, initial.applied[0]!.line);
  assert.equal(updated.text, initial.text.replace(initial.applied[0]!.line, updated.applied[0]!.line));
  assert.deepEqual(updated.skipped, []);
  assert.equal(merge(updated.text, updated.applied, [entry]).text, updated.text);
  assert.equal(merge(updated.text, updated.applied, []).text, updated.text);
});

test("checked tasks, owner wording and manual content win over revised proposals", () => {
  const second = { ...first, id: "task:opaque-2", text: "Inspect the second fixture" };
  const initial = merge(null, [], [first, second]);
  const firstLine = initial.applied[0]!.line;
  const secondLine = initial.applied[1]!.line;
  const manual = "- [ ] Manually chosen fixture\n";
  const current = initial.text.replace(firstLine, firstLine.replace("[ ]", "[x]"))
    .replace(secondLine, secondLine.replace(second.text, "Owner changed this fixture"))
    .replace("## Notes\n", `## Notes\n${manual}`);
  const revised = merge(current, initial.applied, [{ ...first, text: "Different proposal" }, { ...second, text: "Another proposal" }]);
  assert.equal(revised.text, current);
  assert.deepEqual(revised.skipped.map(item => item.reason), ["owner_edited", "owner_edited"]);
  assert.deepEqual(revised.applied, initial.applied);
});

test("removed entries and removed markers stay removed through later revisions", () => {
  const initial = merge(null);
  for (const current of [
    initial.text.replace(initial.applied[0]!.line + "\n", ""),
    initial.text.replace(/ <!-- umpi-plan:task:opaque-1 -->/, ""),
  ]) {
    const removed = merge(current, initial.applied, [{ ...first, text: "New wording" }]);
    assert.equal(removed.text, current);
    assert.deepEqual(removed.skipped, [{ id: first.id, reason: "owner_removed" }]);
    const omitted = merge(removed.text, removed.applied, []);
    assert.deepEqual(omitted.applied, initial.applied);
    assert.equal(merge(omitted.text, omitted.applied).text, current);
  }
});

test("matching manual unchecked, checked and plain bullets are not duplicated or adopted", () => {
  for (const prefix of ["- [ ] ", "- [x] ", "* [X] ", "- "]) {
    const current = `# Existing\n\n## Plan\n\n### Tasks\n${prefix}${first.text}\n`;
    const result = merge(current);
    assert.equal(result.text, current);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.skipped, [{ id: first.id, reason: "already_present" }]);
  }
});

test("duplicate proposal identities fail even with revised wording; unknown markers are never adopted", () => {
  assert.throws(() => merge(null, [], [first, { ...first, text: "Different wording" }]), /identity/);
  const initial = merge(null);
  assert.throws(() => merge(initial.text, [initial.applied[0]!, initial.applied[0]!]), /identity/);
  const orphan = merge(initial.text, [], [{ ...first, text: "Cannot claim this marker" }]);
  assert.equal(orphan.text, initial.text);
  assert.deepEqual(orphan.applied, []);
  assert.equal(orphan.skipped[0]!.reason, "already_present");
  const duplicateMarker = initial.text.replace(initial.applied[0]!.line, `${initial.applied[0]!.line}\n${initial.applied[0]!.line}`);
  assert.equal(merge(duplicateMarker, initial.applied, [{ ...first, text: "Changed" }]).text, duplicateMarker);
});

test("reuses setext and decorated headings, ignores fenced headings, preserves CRLF and protected sections", () => {
  const code = "```md\r\n### Tasks\r\n- [ ] An example\r\n```\r\n";
  const protectedTail = "## Done / changed\r\n- [x] Synthetic completed item\r\n\r\n## Notes\r\nOwner prose  \r\n\r\n## Links\r\n- Existing link\r\n";
  const current = `Existing title\r\n==============\r\n\r\n${code}\r\nPlan\r\n----\r\n\r\n### Schedule ###\r\n\r\n${protectedTail}`;
  const result = merge(current, [], [first, { id: "event:opaque-2", section: "schedule", text: "09:00 Synthetic event", certainty: "tentative" }]);
  assert.ok(result.text.includes(code));
  assert.ok(result.text.includes("Plan\r\n----\r\n"));
  assert.ok(result.text.includes("### Schedule ###\r\n"));
  assert.ok(result.text.endsWith(protectedTail));
  assert.equal(result.text.replaceAll("\r\n", "").includes("\n"), false);
  assert.ok(result.text.indexOf(result.applied[0]!.line) < result.text.indexOf("## Done / changed"));
  assert.ok(result.applied[1]!.line.includes("[tentative]"));
});

test("keeps existing root Links and never inserts into Notes or Done", () => {
  const current = "# Existing\n\n## Done / changed\nuntouched\n\n## Notes\n### Tasks\nManual nested text\n\n## Links\n";
  const link: PlanEntry = { id: "link:opaque-1", section: "links", text: "[Synthetic resource](https://example.com)" };
  const result = merge(current, [], [first, link]);
  assert.equal(result.text.split("## Links\n").length, 2);
  assert.ok(result.text.includes("## Notes\n### Tasks\nManual nested text\n\n"));
  assert.ok(result.text.indexOf(result.applied[0]!.line) < result.text.indexOf("## Done / changed"));
  assert.ok(result.text.indexOf(result.applied[1]!.line) > result.text.indexOf("## Links"));
});

test("new tasks and schedule entries stay outside protected descendant headings", () => {
  for (const section of ["tasks", "schedule"] as const) {
    for (const protectedLabel of ["Notes", "Done / changed"]) {
      const label = section === "tasks" ? "Tasks" : "Schedule";
      const protectedTail = `#### ${protectedLabel}\nOwner text  \n\n##### Details\nKeep this exact text\n\n## Links\n`;
      const current = `# Existing\n\n## Plan\n\n### ${label}\nOwner section text\n\n${protectedTail}`;
      const entry = { ...first, section };
      const result = merge(current, [], [entry]);
      assert.ok(result.text.endsWith(protectedTail));
      assert.ok(result.text.indexOf(result.applied[0]!.line) > result.text.indexOf(`### ${label}\n`));
      assert.ok(result.text.indexOf(result.applied[0]!.line) < result.text.indexOf(`#### ${protectedLabel}\n`));
      assert.equal(merge(result.text, result.applied, [entry]).text, result.text);
      const revised = merge(result.text, result.applied, [{ ...entry, text: "Revised synthetic fixture" }]);
      assert.ok(revised.text.endsWith(protectedTail));
      assert.deepEqual(revised.skipped, []);
    }
  }
});

test("moving an owned entry into Notes or a fenced example removes write authority", () => {
  const initial = merge(null);
  const line = initial.applied[0]!.line;
  for (const destination of [`## Notes\n${line}\n`, `## Notes\n\n~~~md\n${line}\n~~~\n`]) {
    const current = initial.text.replace(line, "").replace("## Notes\n", destination);
    const result = merge(current, initial.applied, [{ ...first, text: "Do not overwrite owner relocation" }]);
    assert.equal(result.text, current);
    assert.equal(result.skipped.length, 1);
  }
});

test("coverage is a readable Plan warning, resolves only unchanged bytes, and can recur", () => {
  const initial = merge(null, [], [], ["Calendar unavailable", "Approved brief unavailable"]);
  assert.equal(initial.applied[0]!.id, "umpi-coverage");
  assert.ok(!initial.applied[0]!.line.startsWith("- [ ]"));
  assert.ok(initial.text.indexOf(initial.applied[0]!.line) < initial.text.indexOf("### Schedule"));
  const resolved = merge(initial.text, initial.applied, [], []);
  assert.equal(resolved.text, initial.text.replace(initial.applied[0]!.line + "\n", ""));
  assert.deepEqual(resolved.applied, []);
  const recurred = merge(resolved.text, resolved.applied, [], ["Calendar unavailable"]);
  assert.equal(recurred.applied.length, 1);
  const edited = initial.text.replace("Calendar unavailable", "Owner annotation");
  const protectedResult = merge(edited, initial.applied, [], []);
  assert.equal(protectedResult.text, edited);
  assert.equal(protectedResult.skipped[0]!.reason, "owner_edited");
  assert.equal(merge(edited, protectedResult.applied, [], ["New coverage issue"]).text, edited);
});

test("rejects malformed dates, marker injection, block prefixes, and ambiguous boundaries", () => {
  for (const invalid of ["2026-02-29", "2026-13-01", "2026-1-01", "not-a-day"]) {
    assert.throws(() => mergeDailyPlan({ day: invalid, current: null, template, previous: [], patch: { entries: [], coverage: [] } }));
    assert.throws(() => planningDayBounds(invalid, "UTC"));
    assert.throws(() => shiftPlanningDay(invalid, 1));
  }
  for (const text of ["text\n## Notes", "text\u0000", "text\u2028next", "<!-- umpi-plan:other -->", "text -->", "# Heading", "- [ ] Checkbox", "[x] Checked", "1. Block"]) {
    assert.throws(() => merge(null, [], [{ ...first, text }]));
  }
  for (const id of ["bad id", "injected -->", "a--b", "\n", "umpi-coverage"]) assert.throws(() => merge(null, [], [{ ...first, id }]));
  for (const invalidTemplate of ["# {{date:HH:mm}}", "{{unknown}}", "```md\n## Plan", "---\ntitle: Unclosed"]) {
    assert.throws(() => mergeDailyPlan({ day, current: null, template: invalidTemplate, previous: [], patch: { entries: [first], coverage: [] } }));
  }
  assert.throws(() => merge("## Plan\n### Tasks\n### Tasks\n"), /ambiguous/);
  assert.throws(() => merge(null, [], [], ["bad\ncoverage"]));
});

test("schedule certainty is explicit for targets and tentative events, without inferring completion", () => {
  const entries: PlanEntry[] = ["confirmed", "target", "tentative"].map((certainty, index) => ({
    id: `event:opaque-${index}`, section: "schedule", text: `Synthetic event ${index}`, certainty: certainty as PlanEntry["certainty"],
  }));
  const result = merge(null, [], entries);
  assert.ok(!result.applied[0]!.line.includes("[confirmed]"));
  assert.ok(result.applied[1]!.line.includes("[target]"));
  assert.ok(result.applied[2]!.line.includes("[tentative]"));
  assert.ok(!result.text.includes("[x]"));
});

test("planning dates use local IANA days and calendar shifts rather than elapsed hours", () => {
  const instant = Date.parse("2026-01-01T00:30:00Z");
  assert.equal(planningDay(instant, "America/Los_Angeles"), "2025-12-31");
  assert.equal(planningDay(instant, "Asia/Kolkata"), "2026-01-01");
  assert.equal(shiftPlanningDay("2024-03-01", -1), "2024-02-29");
  assert.equal(shiftPlanningDay("2025-12-31", 1), "2026-01-01");
  assert.throws(() => shiftPlanningDay(day, 0.5));
  for (const timezone of ["Not/A_Zone", "+05:30", ""]) {
    assert.throws(() => planningDay(instant, timezone));
    assert.throws(() => nextPlanningTime(instant, timezone, "02:30"));
  }
  for (const time of ["2:30", "24:00", "02:60", "02:30:00"]) assert.throws(() => nextPlanningTime(instant, "UTC", time));
});

test("daily scheduling is strictly future and converts fractional-offset local wall times", () => {
  const due = Date.parse("2026-10-11T21:00:00Z");
  assert.equal(nextPlanningTime(due - 1, "Asia/Kolkata", "02:30"), due);
  assert.equal(nextPlanningTime(due, "Asia/Kolkata", "02:30"), Date.parse("2026-10-12T21:00:00Z"));
  assert.deepEqual(planningDayBounds(day, "Asia/Kolkata"), { start: "2026-10-11T18:30:00Z", end: "2026-10-12T18:30:00Z" });
});

test("DST gaps choose the first valid instant, including half-hour transitions", () => {
  assert.equal(nextPlanningTime(Date.parse("2026-03-08T05:00:00Z"), "America/New_York", "02:00"), Date.parse("2026-03-08T07:00:00Z"));
  assert.equal(nextPlanningTime(Date.parse("2026-03-08T05:00:00Z"), "America/New_York", "02:30"), Date.parse("2026-03-08T07:00:00Z"));
  assert.equal(nextPlanningTime(Date.parse("2026-10-03T13:00:00Z"), "Australia/Lord_Howe", "02:15"), Date.parse("2026-10-03T15:30:00Z"));
});

test("DST folds use the first occurrence only; day bounds follow next local midnight", () => {
  const firstOccurrence = Date.parse("2026-11-01T05:30:00Z");
  assert.equal(nextPlanningTime(firstOccurrence - 1, "America/New_York", "01:30"), firstOccurrence);
  assert.equal(nextPlanningTime(firstOccurrence, "America/New_York", "01:30"), Date.parse("2026-11-02T06:30:00Z"));
  assert.equal(nextPlanningTime(Date.parse("2026-11-01T06:00:00Z"), "America/New_York", "01:30"), Date.parse("2026-11-02T06:30:00Z"));
  for (const [date, hours] of [["2026-03-08", 23], ["2026-11-01", 25]] as const) {
    const bounds = planningDayBounds(date, "America/New_York");
    assert.equal((Date.parse(bounds.end) - Date.parse(bounds.start)) / 3_600_000, hours);
  }
  assert.deepEqual(planningDayBounds("2011-12-30", "Pacific/Apia"), { start: "2011-12-30T10:00:00Z", end: "2011-12-30T10:00:00Z" });
});
