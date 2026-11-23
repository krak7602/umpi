import assert from "node:assert/strict";
import test from "node:test";
import { editNoteLine } from "../src/shared/note-edit.js";

const NOTE = [
  "---", "tags: [daily]", "title: Buy oats", "---",
  "# Apr 15th, 2027", "", "## Plan", "", "### Schedule", "",
  "- 10:00–10:15 Standup <!-- umpi-plan:calendar-abc -->",
  "- [tentative] 14:30–15:00 Review with Asha <!-- umpi-plan:calendar-def -->",
  "", "### Tasks", "",
  "- [ ] Buy oats",
  "- [x] Renew the library card <!-- umpi-plan:note-1 -->",
  "  - [ ] Bring the old card",
  "", "## Notes", "",
  "Paid the electricity bill, 1,200.",
  "- Idea: a shelf for the hallway",
  "```", "- [ ] Buy oats in a code block", "```", "",
].join("\n");

function edited(result: ReturnType<typeof editNoteLine>) {
  assert.equal(result.status, "edited", JSON.stringify(result));
  return result as Extract<ReturnType<typeof editNoteLine>, { status: "edited" }>;
}

test("replace rewords one line and keeps its bullet, checkbox, indent, marker, and every other byte", () => {
  const result = edited(editNoteLine(NOTE, { line: "Renew the library card", action: "replace", text: "Renew the gym pass" }));
  assert.equal(result.text, NOTE.replace("- [x] Renew the library card <!-- umpi-plan:note-1 -->", "- [x] Renew the gym pass <!-- umpi-plan:note-1 -->"));
  assert.deepEqual([result.before, result.after], ["[x] Renew the library card", "[x] Renew the gym pass"]);
  const nested = edited(editNoteLine(NOTE, { line: "bring the OLD card", action: "replace", text: "- [ ] Bring both cards" }));
  assert.ok(nested.text.includes("\n  - [ ] Bring both cards\n"), "list marks in the new text are not doubled");
  const plain = edited(editNoteLine(NOTE, { line: "Paid the electricity bill, 1,200.", action: "replace", text: "Paid the electricity bill, 1,450." }));
  assert.ok(plain.text.includes("\nPaid the electricity bill, 1,450.\n"));
});

test("a line is found by its whole text, by its text without a plan mark, or by words only it contains", () => {
  assert.equal(edited(editNoteLine(NOTE, { line: "- [tentative] 14:30–15:00 Review with Asha", action: "remove" })).after, null);
  assert.equal(edited(editNoteLine(NOTE, { line: "14:30–15:00 Review with Asha", action: "remove" })).before, "[tentative] 14:30–15:00 Review with Asha");
  const removed = edited(editNoteLine(NOTE, { line: "shelf for the hallway", action: "remove" }));
  assert.equal(removed.text, NOTE.replace("- Idea: a shelf for the hallway\n", ""));
  assert.deepEqual(editNoteLine(NOTE, { line: "card", action: "remove" }), { status: "ambiguous", matches: ["[x] Renew the library card", "[ ] Bring the old card"] });
  assert.deepEqual(editNoteLine(NOTE, { line: "Water the plants", action: "remove" }), { status: "not_found" });
  assert.deepEqual(editNoteLine(NOTE, { line: "at", action: "remove" }), { status: "not_found" }, "a few letters never pick a line");
});

test("frontmatter, headings, and code blocks are not lines an edit can touch", () => {
  const result = edited(editNoteLine(NOTE, { line: "Buy oats", action: "remove" }));
  assert.ok(result.text.includes("title: Buy oats") && result.text.includes("- [ ] Buy oats in a code block"));
  assert.ok(!result.text.includes("\n- [ ] Buy oats\n"));
  assert.deepEqual(editNoteLine(NOTE, { line: "Plan", action: "remove" }), { status: "not_found" });
  assert.deepEqual(editNoteLine(NOTE, { line: "tags: [daily]", action: "remove" }), { status: "not_found" });
});

test("check and uncheck change only a task's box, and an edit asked twice changes nothing", () => {
  const ticked = edited(editNoteLine(NOTE, { line: "Buy oats", action: "check" }));
  assert.ok(ticked.text.includes("\n- [x] Buy oats\n"));
  assert.deepEqual(editNoteLine(ticked.text, { line: "Buy oats", action: "check" }), { status: "unchanged", before: "[x] Buy oats" });
  assert.equal(editNoteLine(NOTE, { line: "10:00–10:15 Standup", action: "check" }).status, "invalid");
  const reworded = edited(editNoteLine(NOTE, { line: "Buy oats", action: "replace", text: "Buy rolled oats" }));
  assert.deepEqual(editNoteLine(reworded.text, { line: "Buy oats", action: "replace", text: "Buy rolled oats" }), { status: "unchanged", before: "Buy rolled oats" });
});

test("new text is one bounded line that cannot add a comment, a marker, or a second line", () => {
  for (const text of ["", "   ", "x".repeat(241), "<!-- umpi-plan:calendar-abc -->"]) assert.equal(editNoteLine(NOTE, { line: "Buy oats", action: "replace", text }).status, "invalid", JSON.stringify(text));
  const result = edited(editNoteLine(NOTE, { line: "Buy oats", action: "replace", text: "Buy oats\n## Injected heading <!-- x -->" }));
  assert.ok(result.text.includes("\n- [ ] Buy oats ## Injected heading x\n"));
  assert.equal(editNoteLine(NOTE, { line: "Buy oats", action: "remove", text: "extra" }).status, "invalid");
  const windows = edited(editNoteLine("- [ ] One\r\n- [ ] Two\r\n", { line: "One", action: "replace", text: "Uno" }));
  assert.equal(windows.text, "- [ ] Uno\r\n- [ ] Two\r\n");
});
