// Authority mutation check. Run it with `npm run test:mutants`. It takes about 25 seconds per mutant.
//
// Each mutant removes one authority check with one exact string replacement in one source file. The check passes when
// the type check or a test fails for every mutant: then each claim below has a test that notices its removal.
//
//   npm run test:mutants                    every mutant
//   npm run test:mutants -- NAME [NAME...]  only these mutants
//   npm run test:mutants -- --list          print the names and claims, run nothing
//   npm run test:mutants -- --tests 'tests/authority.test.ts'   run only these test files (quick, for development)
//   npm run test:mutants -- --no-types      skip the type check (only while the tree does not type-check for another reason)
//
// The work happens on a copy of the tree in a temporary folder outside the repository: the files Git tracks or would
// track (ignored private configuration is not copied), with `node_modules` linked. The working tree is never edited.
//
// Results: `killed` (the type check or a test failed), `SURVIVED` (nothing noticed), `known survivor` (no test can
// reach the check; the reason is in the list), `ANCHOR` (the `find` text is no longer in the file exactly once).
// Exit code 1 when a mutant survives, an anchor is missing, the unchanged copy fails, or a known survivor is killed
// (then remove its `knownSurvivor`). Update `find` when the source line changes; do not delete a mutant to make
// the check pass.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * name: stable short name. claim: what stays true while the check exists. find: exact text, present once in `file`.
 * replace: the text without the check. knownSurvivor: why no test can notice the removal; reported, does not fail.
 */
const MUTANTS = [
  // Background reviews -------------------------------------------------------------------------------------------
  { name: "bg-tool-allowlist", file: "src/worker/proactive-runtime.ts", claim: "A background review calls only the tools on the background list.",
    find: "!backgroundTools.has(tool.name) && !extra(String(api.conversationId), tool.name)", replace: "false" },
  { name: "bg-approval-quiet-hours", file: "src/worker/proactive-runtime.ts", claim: "A background review cannot show an approval card when it may not notify or in quiet hours.",
    find: "!proactive.mayInterrupt(String(api.conversationId))", replace: "false" },
  { name: "mail-read-foreground-only", file: "src/worker/mail-tools.ts", claim: "A background session cannot read mail through the owner's mail tool.",
    find: "if (store.proactive.owner.isBackgroundSession(sessionId)) throw new StateError(403, \"Background mail access", replace: "if (false) throw new StateError(403, \"Background mail access" },
  // The nightly run ----------------------------------------------------------------------------------------------
  { name: "nightly-cannot-reschedule-itself", file: "src/worker/dream-tools.ts", claim: "The nightly run cannot change its own commitment or schedule.",
    find: "if (restricted[tool.name]) return result(() => { throw new StateError(403, \"The nightly run cannot rewrite its commitment or schedule.\"); });", replace: "" },
  { name: "nightly-commit-once", file: "src/worker/dream-store.ts", claim: "The nightly run commits once.",
    find: "if (night.status !== \"requested\") return night;", replace: "" },
  { name: "lesson-cap", file: "src/worker/dream-store.ts", claim: "At most 30 lessons are active.",
    find: "if (this.lessons().length >= MAX_ACTIVE_LESSONS) throw", replace: "if (false) throw" },
  { name: "lesson-revert-owner-only", file: "src/worker/dream-tools.ts", claim: "Only the owner's conversation can revert or retire a lesson.",
    find: "if (isBackground(String(api.conversationId))) throw new StateError(403, \"Only the owner can change lessons\")", replace: "if (false) throw new StateError(403, \"x\")" },
  { name: "probe-repair-threshold", file: "src/worker/dream-tools.ts", claim: "A probe the nightly summary cannot answer is added back to the summary.",
    find: "(answers[`p${index}`] ?? 0) < 0.5", replace: "(answers[`p${index}`] ?? 0) < 0" },
  { name: "lesson-quotes-owner", file: "src/worker/dream-store.ts", claim: "The night adds a lesson only when its evidence quotes the owner.",
    find: "if (typeof evidence !== \"string\" || !evidenceQuotesOwner(evidence, ownerLines)) {", replace: "if (typeof evidence !== \"string\") {" },
  { name: "instruction-quotes-owner", file: "src/worker/dream-store.ts", claim: "The night keeps a new standing instruction only when it quotes the owner.",
    find: "if (quotesOwner(text, ownerLines)) return [text.replace(/\\s+/g, \" \")];", replace: "if (text) return [text.replace(/\\s+/g, \" \")];" },
  // Web search ---------------------------------------------------------------------------------------------------
  { name: "web-foreground-only", file: "src/worker/web-search.ts", claim: "The web tools refuse the sessions their `foreground` check names.",
    find: "if (isBackground(conversationId)) throw", replace: "if (false) throw" },
  { name: "web-monthly-budget", file: "src/worker/web-search.ts", claim: "Web search stops at the monthly budget.",
    find: "if (state.spent + cost > this.budget()) throw", replace: "if (false) throw" },
  { name: "web-url-provenance", file: "src/worker/web-search.ts", claim: "read_web_page reads only a URL that a search returned, a read page linked, or the owner wrote.",
    find: "if (url && (await seen.has(conversationId, url) || options.ownerWrote?.(url, conversationId) === true)) urls.push(url);", replace: "if (url) urls.push(url);" },
  // Turn provenance ----------------------------------------------------------------------------------------------
  { name: "provenance-gate", file: "src/worker/provenance.ts", claim: "A tool that acts without a card runs only when Store.ownerDirected allows it.",
    find: "if (!check.ok) {", replace: "if (!check.ok && Date.now() < 0) {" },
  { name: "provenance-marks-outside-text", file: "src/worker/provenance.ts", claim: "A tool that returns outside text marks the turn before it runs.",
    find: "if (reads) store.markOutsideText(session, tool.name);", replace: "" },
  { name: "provenance-no-turn", file: "src/worker/store.ts", claim: "With no turn in flight, an owner-directed action is refused.",
    find: "if (!turns.length) return { ok: false, why: \"no owner message is being answered\" };", replace: "" },
  { name: "provenance-background-turn", file: "src/worker/store.ts", claim: "A background review is never the owner's request.",
    find: "if (turns.some(op => op.background)) return { ok: false, why: \"this is a background review, not the owner's conversation\" };", replace: "" },
  { name: "provenance-result-turn", file: "src/worker/store.ts", claim: "A turn that a result or notice started is not the owner's request.",
    find: "if (turns.some(op => op.origin === \"result\")) return { ok: false, why: \"this turn was started by a result or notice, not by the owner\" };", replace: "" },
  { name: "provenance-outside-text", file: "src/worker/store.ts", claim: "A turn that read outside text is not the owner's request.",
    find: "if (outside.length) return { ok: false, why:", replace: "if (false) return { ok: false, why:" },
  // Approvals and buttons ----------------------------------------------------------------------------------------
  { name: "job-approval-version-bound", file: "src/worker/store.ts", claim: "A job approval names the job's current version.",
    find: "if (expectedVersion === undefined) throw new StateError(400, \"Use the approval button, or provide the job's current version\");\n    this.requireVersion(job.version, expectedVersion);", replace: "" },
  { name: "t3-card-matches-action", file: "src/worker/t3-actions.ts", claim: "Approve runs a T3 action only when the stored action still matches the card that was shown.",
    find: "if (!this.shown(request)) {", replace: "if (false) {" },
  { name: "t3-app-press-group", file: "src/worker/t3-actions.ts", claim: "An app press on a T3 card must name that card's message group.",
    find: "(messageId === undefined ? groupId === group :", replace: "(messageId === undefined ? true :" },
  { name: "app-button-group", file: "src/worker/store.ts", claim: "Store.buttonShown accepts an app press only for the group that holds the button.",
    find: "if (typeof binding !== \"number\") return binding.groupId === groupId && deliveries.some(hasButton);", replace: "if (typeof binding !== \"number\") return deliveries.some(hasButton);" },
  { name: "app-callback-group", file: "src/worker/store.ts", claim: "An app press resolves a button only in the group it names.",
    find: ": interaction.groupId === binding.groupId ? this.deliveries(interaction.groupId).find(hasButton) : undefined;", replace: ": this.deliveries(interaction.groupId).find(hasButton);" },
  // Mail, stored results, decisions ------------------------------------------------------------------------------
  { name: "mail-starred-always-passes", file: "src/worker/mail-store.ts", claim: "A starred thread always passes the mail screen.",
    find: "old.starred === true || verdict.attention >= MAIL_SCREEN_ATTENTION", replace: "verdict.attention >= MAIL_SCREEN_ATTENTION" },
  { name: "mail-screen-outage-passes", file: "src/worker/mail-store.ts", claim: "When the mail screen is unavailable, the thread passes.",
    find: "const clears = verdict === null || (", replace: "const clears = verdict !== null && (" },
  { name: "stored-result-conversation-bound", file: "src/worker/context-health.ts", claim: "A stored tool result is read only by the conversation that produced it.",
    find: "WHERE id=? AND conversation_id=?\", id, conversationId", replace: "WHERE id=?\", id" },
  { name: "decision-monthly-budget", file: "src/worker/decisions.ts", claim: "Decision models stop at the monthly budget.",
    find: "if (this.state().spent >= this.budget()) throw new DecisionUnavailable(\"This month's decision budget is used\");\n    if (JSON.stringify", replace: "if (JSON.stringify" },
  { name: "effort-min-confidence", file: "src/worker/decisions.ts", claim: "An effort choice below the confidence floor falls back.",
    find: ">= EFFORT_MIN_CONFIDENCE ? EFFORT_OF[choice] : options.fallback", replace: ">= 0 ? EFFORT_OF[choice] : options.fallback" },
  // Transport ----------------------------------------------------------------------------------------------------
  { name: "device-token-is-not-admin-token", file: "src/worker/transport.ts", claim: "A control, executor, or synchronizer token is never a device credential.",
    find: "if (token && await secretEqual(authorization, `Bearer ${token}`)) throw", replace: "if (false) throw" },
  { name: "telegram-webhook-secret", file: "src/worker/transport.ts", claim: "The Telegram webhook needs its secret.",
    find: "if (!await secretEqual(request.headers.get(\"x-telegram-bot-api-secret-token\") ?? \"\", env.TELEGRAM_WEBHOOK_SECRET!)) throw", replace: "if (false) throw" },
  { name: "route-token-required", file: "src/worker/transport.ts", claim: "A control or executor route needs its own token.",
    find: "if (!await secretEqual(request.headers.get(\"authorization\") ?? \"\", `Bearer ${token}`)) throw new StateError(401, \"Unauthorized\");", replace: "" },
  // Tool profiles (src/worker/profiles.ts) -----------------------------------------------------------------------
  { name: "nightly-only-web", file: "src/worker/profiles.ts", claim: "Only the nightly run's session gets web search and history in a background review.",
    find: "NIGHTLY_ONLY_TOOLS.includes(tool) && s.dream.ownsSession(session)", replace: "NIGHTLY_ONLY_TOOLS.includes(tool)" },
  { name: "web-foreground-wiring", file: "src/worker/profiles.ts", claim: "The web tools themselves refuse a background session that is not the nightly run.",
    find: "s.store.isBackgroundSession(id) && !s.dream.ownsSession(id))", replace: "false)" },
  { name: "web-owner-links-foreground-only", file: "src/worker/profiles.ts", claim: "A background session, the nightly run included, gets no owner-written links.",
    find: "!s.store.isBackgroundSession(id) && ownerWroteUrl(", replace: "ownerWroteUrl(" },
  { name: "delegation-needs-foreground-parent", file: "src/worker/profiles.ts", claim: "Only a channel's own foreground conversation may delegate to a subagent.",
    find: "if (stores.store.isBackgroundSession(parentSessionId) || stores.store.session(channel) !== parentSessionId) throw new StateError(403, \"Only an original foreground parent may delegate\");", replace: "" },
  { name: "background-cannot-delegate", file: "src/worker/profiles.ts", claim: "A session registered as background cannot delegate, whatever else it is registered as.",
    find: "stores.store.isBackgroundSession(parentSessionId) || ", replace: "" },
  { name: "owner-profile-provenance", file: "src/worker/profiles.ts", claim: "The owner conversation's tools are wrapped by the provenance guard.",
    find: "tools: provenance([", replace: "tools: ((tools: ToolRegistration[], ..._rest: unknown[]) => tools)([" },
  { name: "review-profile-slim", file: "src/worker/profiles.ts", claim: "A background review's tool list holds only the tools a review may use.",
    find: ".filter(tool => backgroundTools.has(tool.name) || NIGHTLY_ONLY_TOOLS.includes(tool.name))", replace: "" },
  // The composition root: no test imports src/worker/index.ts --------------------------------------------------------
  { name: "index:auth-before-routes", file: "src/worker/index.ts", claim: "The coordinator authorizes a request before its routes.",
    find: "      await authorize(request, this.config);\n", replace: "",
    knownSurvivor: "onRequest lives in the Assistant Durable Object, which no test can import. The Worker entry authorizes before it forwards, and tests/authority.test.ts covers `authorize` for every route family." },
  { name: "index:delivery-holds-dependency", file: "src/worker/index.ts", claim: "Telegram delivery is skipped when the delivery-holds stage failed.",
    find: "{ name: \"telegram-delivery\", needs: [\"delivery-holds\"], run:", replace: "{ name: \"telegram-delivery\", run:",
    knownSurvivor: "The stage list is built inside the Coordinator class in index.ts, which no test can import. tests/faults.test.ts covers `needs` in runStages; the wiring of this one stage is not covered." },
];

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); if (at < 0) return undefined; const [, value] = args.splice(at, 2); return value ?? ""; };
const tests = flag("--tests") || "tests/*.test.ts";
const list = args.includes("--list"), types = !args.includes("--no-types");
const only = args.filter(arg => !arg.startsWith("--"));
const unknown = only.filter(name => !MUTANTS.some(mutant => mutant.name === name));
if (unknown.length) { console.error(`Unknown mutant: ${unknown.join(", ")}`); process.exit(1); }
if (new Set(MUTANTS.map(mutant => mutant.name)).size !== MUTANTS.length) { console.error("Two mutants share a name"); process.exit(1); }
const selected = MUTANTS.filter(mutant => !only.length || only.includes(mutant.name));

if (list) {
  for (const mutant of selected) console.log(`${mutant.name}\n  ${mutant.file}\n  ${mutant.claim}${mutant.knownSurvivor ? `\n  known survivor: ${mutant.knownSurvivor}` : ""}`);
  process.exit(0);
}

// Anchors are checked for the whole list before anything runs, so a stale one is reported at once.
const occurrences = mutant => existsSync(join(root, mutant.file)) ? readFileSync(join(root, mutant.file), "utf8").split(mutant.find).length - 1 : -1;
const stale = MUTANTS.map(mutant => ({ mutant, count: occurrences(mutant) })).filter(item => item.count !== 1);
for (const { mutant, count } of stale) console.error(`ANCHOR  ${mutant.name}: ${count < 0 ? `${mutant.file} does not exist` : `found ${count} times in ${mutant.file}, expected once`}`);

const copy = mkdtempSync(join(tmpdir(), "umpi-mutants-"));
const cleanup = () => { try { unlinkSync(join(copy, "node_modules")); } catch { /* not linked yet */ } rmSync(copy, { recursive: true, force: true }); };
process.on("SIGINT", () => { cleanup(); process.exit(130); });

function check() {
  for (const project of types ? ["tsconfig.worker.json", "tsconfig.mac.json"] : []) {
    const types = spawnSync(join(copy, "node_modules/.bin/tsc"), ["-p", project, "--noEmit"], { cwd: copy, encoding: "utf8" });
    if (types.status !== 0) return { ok: false, by: `type check (${project})`, failed: 0 };
  }
  const run = spawnSync("sh", ["-c", `node_modules/.bin/tsx --test ${tests} 2>&1`], { cwd: copy, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const titles = [...new Set([...run.stdout.matchAll(/^✖ (.+?) \(\d/gm)].map(match => match[1]))];
  const failed = Number(/^ℹ fail (\d+)/m.exec(run.stdout)?.[1] ?? (run.status === 0 ? 0 : 1));
  return { ok: run.status === 0, by: titles[0] ?? "the test run", failed: Math.max(failed, titles.length) };
}

let exit = stale.length ? 1 : 0;
try {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  for (const file of files) {
    if (!existsSync(join(root, file))) continue; // Deleted in the working tree.
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    copyFileSync(join(root, file), join(copy, file));
  }
  symlinkSync(join(root, "node_modules"), join(copy, "node_modules"), "dir");

  const started = Date.now();
  const baseline = check();
  if (!baseline.ok) {
    console.error(`The unchanged copy fails (${baseline.by}). Fix the tree first: a failing tree makes every mutant look killed.`);
    exit = 1;
  } else {
    console.log(`Unchanged copy passes (${Math.round((Date.now() - started) / 1000)} s). ${selected.length} mutant(s), tests: ${tests}${types ? "" : ", type check skipped"}\n`);
    const rows = [];
    for (const mutant of selected) {
      if (stale.some(item => item.mutant === mutant)) { rows.push({ mutant, result: "ANCHOR", detail: "the `find` text is not in the file exactly once" }); continue; }
      const path = join(copy, mutant.file), original = readFileSync(path, "utf8");
      writeFileSync(path, original.replace(mutant.find, () => mutant.replace));
      let outcome;
      try { outcome = check(); } finally { writeFileSync(path, original); }
      const row = outcome.ok
        ? mutant.knownSurvivor ? { mutant, result: "known survivor", detail: mutant.knownSurvivor } : { mutant, result: "SURVIVED", detail: "no test noticed" }
        : mutant.knownSurvivor ? { mutant, result: "KILLED, listed as known survivor", detail: `${outcome.by}; remove its knownSurvivor` }
          : { mutant, result: "killed", detail: `${outcome.by}${outcome.failed > 1 ? ` (+${outcome.failed - 1} more)` : ""}` };
      if (row.result !== "killed" && row.result !== "known survivor") exit = 1;
      rows.push(row);
      console.log(`${row.result.padEnd(15)} ${mutant.name}\n${" ".repeat(16)}${mutant.claim}\n${" ".repeat(16)}${row.detail}`);
    }
    const count = result => rows.filter(row => row.result === result).length;
    console.log(`\n${count("killed")} killed, ${count("SURVIVED")} survived, ${count("known survivor")} known survivor(s), ${count("ANCHOR")} missing anchor(s), ${rows.length - count("killed") - count("SURVIVED") - count("known survivor") - count("ANCHOR")} known survivor(s) now killed. ${Math.round((Date.now() - started) / 1000)} s.`);
  }
} finally { cleanup(); }
process.exit(exit);
