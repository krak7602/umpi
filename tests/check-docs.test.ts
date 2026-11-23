import assert from "node:assert/strict";
import test from "node:test";
import {
  checkFrontMatter, checkUpdated, dateOnlyChanges, extractHeadings, extractLinks, headingAnchor, isValidDate, parseFrontMatter,
  reachablePages, repositoryPathIn, resolveLinkPath, scanMarkdown, splitTarget,
} from "../scripts/check-docs.ts";

test("heading anchors follow GitHub's rules", () => {
  assert.equal(headingAnchor("Hosted operation"), "hosted-operation");
  assert.equal(headingAnchor("Pairing, tools, and HTTP contract"), "pairing-tools-and-http-contract");
  assert.equal(headingAnchor("1. Verify without live credentials"), "1-verify-without-live-credentials");
  assert.equal(headingAnchor("Amendment: one machine per session"), "amendment-one-machine-per-session");
  // Punctuation is removed and each space becomes a hyphen; runs are not collapsed.
  assert.equal(headingAnchor("Read & write"), "read--write");
  assert.equal(headingAnchor("The `npm run check:docs` command"), "the-npm-run-checkdocs-command");
  assert.equal(headingAnchor("See [the runbook](../runbooks/setup.md) first"), "see-the-runbook-first");
  assert.equal(headingAnchor("An _important_ snake_case name"), "an-important-snake_case-name");
  assert.equal(headingAnchor("Read-only **mail** follow-through"), "read-only-mail-follow-through");
  assert.equal(headingAnchor("Café menü"), "café-menü");
});

test("a repeated heading gets a numbered anchor, and fenced code holds no headings", () => {
  const headings = extractHeadings(["# Title", "## Setup", "```markdown", "## Not a heading", "```", "## Setup", "### Setup ##", "~~~", "# Also code", "~~~"].join("\n"));
  assert.deepEqual(headings.map((heading) => [heading.line, heading.level, heading.slug]), [[1, 1, "title"], [2, 2, "setup"], [6, 2, "setup-1"], [7, 3, "setup-2"]]);
});

test("link extraction reads inline links, images, and reference definitions, but not code", () => {
  const text = [
    "See [the plan](plan.md#steps) and [the site](https://example.org/a_(b)).",
    "![diagram](images/flow.png \"Flow\") and [spaced](<notes/my file.md>).",
    "Inline code `[not](a-link.md)` is skipped.",
    "```sh",
    "echo \"[also](not-a-link.md)\"",
    "```",
    "[ref]: ../other/page.md#part",
  ].join("\n");
  assert.deepEqual(extractLinks(text), [
    { line: 1, target: "plan.md#steps" }, { line: 1, target: "https://example.org/a_(b" },
    { line: 2, target: "images/flow.png" }, { line: 2, target: "notes/my file.md" },
    { line: 7, target: "../other/page.md#part" },
  ]);
});

test("link targets split into path and anchor and resolve against their page", () => {
  assert.deepEqual(splitTarget("plan.md#steps"), { external: false, path: "plan.md", anchor: "steps" });
  assert.deepEqual(splitTarget("#steps"), { external: false, path: "", anchor: "steps" });
  assert.deepEqual(splitTarget("my%20file.md"), { external: false, path: "my file.md", anchor: null });
  assert.equal(splitTarget("https://example.org/a#b").external, true);
  assert.equal(splitTarget("mailto:reader@example.org").external, true);
  assert.equal(resolveLinkPath("docs/subsystems/runtime.md", "../runbooks/setup.md"), "docs/runbooks/setup.md");
  assert.equal(resolveLinkPath("docs/TAXONOMY.md", "../README.md"), "README.md");
  assert.equal(resolveLinkPath("README.md", "docs/"), "docs");
  assert.equal(resolveLinkPath("README.md", "/docs/architecture.md"), "docs/architecture.md");
  assert.equal(resolveLinkPath("README.md", "../outside.md"), null);
});

test("front matter parsing returns keys with their lines", () => {
  const frontMatter = parseFrontMatter(["---", "title: Kettle controller", "aliases: [boiler, tea timer]", "updated: 2031-02-03", "---", "", "# Kettle controller"].join("\n"));
  assert.equal(frontMatter?.endLine, 5);
  assert.deepEqual(frontMatter?.keys.get("updated"), { value: "2031-02-03", line: 4 });
  assert.equal(frontMatter?.keys.get("aliases")?.value, "[boiler, tea timer]");
  assert.equal(parseFrontMatter("# No front matter\n"), null);
  assert.equal(parseFrontMatter("---\ntitle: Never closed\n\n# Heading\n"), null);
});

test("front matter needs title, aliases, and updated; a decision also needs status", () => {
  const subject = parseFrontMatter("---\ntitle: Kettle controller\naliases: [boiler]\nupdated: 2031-02-03\n---\n");
  assert.deepEqual(checkFrontMatter("docs/subsystems/kettle.md", subject), []);
  assert.deepEqual(checkFrontMatter("docs/decisions/2031-02-03-kettle.md", subject), [{ line: 1, message: "front matter has no `status:`" }]);
  assert.deepEqual(checkFrontMatter("docs/subsystems/kettle.md", null), [{ line: 1, message: "the page has no front matter block" }]);
  const empty = parseFrontMatter("---\ntitle:\naliases: []\nupdated: 2031-02-03\n---\n");
  assert.deepEqual(checkFrontMatter("docs/subsystems/kettle.md", empty).map((problem) => problem.line), [2, 3]);
});

test("History dates come only from the History section", () => {
  const page = scanMarkdown(["---", "title: Kettle", "aliases: [boiler]", "updated: 2031-02-03", "---", "## Current", "- 2031-09-09: not a History entry", "## History", "- 2031-01-05: First version.", "* 2031-02-03: Added the timer.", "## Notes", "- 2031-12-31: outside History again"].join("\n"));
  assert.deepEqual(page.historyDates, ["2031-01-05", "2031-02-03"]);
});

test("the updated rule", () => {
  const base = { historyDates: ["2031-01-05", "2031-02-03"], today: "2031-03-01" };
  assert.deepEqual(checkUpdated({ ...base, updated: "2031-02-03", lastCommit: "2031-02-03" }), []);
  assert.deepEqual(checkUpdated({ ...base, updated: "2031-02-10", lastCommit: "2031-02-03" }), []);
  assert.deepEqual(checkUpdated({ ...base, updated: "2031-2-3" }).map((problem) => problem.level), ["error"]);
  assert.deepEqual(checkUpdated({ ...base, updated: "2031-02-30" }).map((problem) => problem.level), ["error"]);
  assert.match(checkUpdated({ ...base, updated: "2031-03-02" })[0]!.message, /in the future/);
  const behindHistory = checkUpdated({ ...base, updated: "2031-01-20" });
  assert.deepEqual(behindHistory.map((problem) => problem.level), ["error"]);
  assert.match(behindHistory[0]!.message, /newest History entry \(2031-02-03\)/);
  // Behind the last commit is a warning only.
  const behindCommit = checkUpdated({ ...base, updated: "2031-02-03", lastCommit: "2031-02-20" });
  assert.deepEqual(behindCommit.map((problem) => problem.level), ["warning"]);
  assert.match(behindCommit[0]!.message, /last commit that changed the page \(2031-02-20\)/);
  // A page with uncommitted changes is compared against today, not against the last commit.
  assert.deepEqual(checkUpdated({ ...base, updated: "2031-03-01", lastCommit: "2031-02-20", uncommitted: true }), []);
  assert.match(checkUpdated({ ...base, updated: "2031-02-25", lastCommit: "2031-02-20", uncommitted: true })[0]!.message, /uncommitted changes/);
  assert.equal(isValidDate("2032-02-29"), true);
  assert.equal(isValidDate("2031-02-29"), false);
});

test("only precise repository paths in backticks are checked", () => {
  const top = new Set(["src", "ios", "tests"]);
  assert.equal(repositoryPathIn("src/worker/kettle.ts", top), "src/worker/kettle.ts");
  assert.equal(repositoryPathIn("ios/App/Kettle.swift:42", top), "ios/App/Kettle.swift");
  assert.equal(repositoryPathIn("src/worker/", top), "src/worker");
  assert.equal(repositoryPathIn("tests/*.test.ts", top), null);
  assert.equal(repositoryPathIn("src/<name>.ts", top), null);
  assert.equal(repositoryPathIn("src/notes/YYYY-MM-DD.md", top), null);
  assert.equal(repositoryPathIn("tsx src/cli/kettle.ts", top), null);
  assert.equal(repositoryPathIn("lib/other/file.ts", top), null);
  assert.equal(repositoryPathIn("/api/kettle/tasks", top), null);
  assert.equal(repositoryPathIn("src/../secret.ts", top), null);
});

test("reachability follows links between known pages only", () => {
  const links = new Map<string, string[]>([
    ["README.md", ["docs/a.md", "LICENSE"]], ["docs/a.md", ["docs/b.md", "README.md"]], ["docs/b.md", []], ["docs/orphan.md", ["docs/a.md"]],
  ]);
  assert.deepEqual([...reachablePages("README.md", links)].sort(), ["README.md", "docs/a.md", "docs/b.md"]);
});

test("a diff that changes only the updated line is not a content change", () => {
  const diff = [
    "diff --git a/docs/kettle.md b/docs/kettle.md", "index 1111111..2222222 100644", "--- a/docs/kettle.md", "+++ b/docs/kettle.md",
    "@@ -4 +4 @@", "-updated: 2031-01-05", "+updated: 2031-02-03",
    "diff --git a/docs/timer.md b/docs/timer.md", "index 3333333..4444444 100644", "--- a/docs/timer.md", "+++ b/docs/timer.md",
    "@@ -4 +4 @@", "-updated: 2031-01-05", "+updated: 2031-02-03", "@@ -20,0 +21 @@", "+The timer now rings twice.",
  ].join("\n");
  assert.deepEqual([...dateOnlyChanges(diff)], ["docs/kettle.md"]);
});
