---
title: Mac executor
aliases: [native execution, execution journal, outbound Mac connection]
updated: 2026-10-14
---

# Mac executor

## Current

### Boundary

`src/mac/` implements an outbound HTTP executor. It does not expose SSH or a listening Mac service. It polls the [coordinator](assistant-runtime.md) with a separate executor credential and advertises canonical workspace roots. An outbound [wake socket](#wake-socket-and-polling) tells it when to poll; work never travels over that socket. The current coordinator dispatches only to an exactly matching advertised workspace.

Commands run as the Mac user through `/bin/sh -c`. Validating the starting directory is **not a filesystem sandbox**: an approved command can access other files and capabilities available to that user. Review the exact command, working directory, timeout, and version before approving it. The initial local setup can restrict advertised workspaces, but it cannot sandbox a native coding harness.

Individual exact-command jobs have no cloud fallback or automatic reassignment. An offline Mac leaves unclaimed work queued. Once claimed, a job keeps its executor owner; a lost connection does not prove that its process stopped. A second executor cannot claim the same running job. Complete [coding tasks](assistant-runtime.md#coding-tasks) have a separate, explicitly approved cloud offer only before native claim.

### Local state

Defaults are `~/.config/umpi/mac/config.json` and its sibling `state/` directory. Configuration and state must be outside the repository and owner-only. Symlinks and shared private files are refused. An exclusive daemon lock prevents two processes from sharing one journal.

The journal binds both the executor ID and coordinator origin. Editing only `serverUrl` cannot move a nonempty journal to another coordinator. The first hosted handoff verified an empty journal and migrated its binding with the private configuration under the exclusive daemon lock. Preserve that identity and history for subsequent restarts; see [hosted operation](../runbooks/local-development.md#hosted-operation).

| Configuration field | Meaning |
| --- | --- |
| `serverUrl` | HTTPS coordinator origin; HTTP is allowed only for exact loopback hosts |
| `executorToken` | Executor-only bearer credential; never the control token |
| `executorId` | Stable identity; preserve it with its journal |
| `workspaces` | Exact existing canonical repository directories; not bulk discovery under a parent folder |
| `pollIntervalMs` | 100–60,000 ms; default 1,000 ms; the interval while work is active ([wake socket](#wake-socket-and-polling)) |
| `coding.enabled` | Default `false`; permits separately approved coding-task claims, not automatic task approval |
| `browser.enabled`, `browser.allSites`, `browser.sites` | Default disabled/false/empty; native eligibility opt-in and optional exact local grants, never task approval |
| `context.enabled` | Default `false`; sends Aside activity summaries and answers owner memory searches ([Aside context](#aside-context)) |

### Wake socket and polling

The executor keeps one outbound WebSocket to `/api/executor/wake` with its executor credential in a request header. The coordinator sends only `wake`, after its reconcile finds Mac work that it has not announced: a queued job, a cancellation, a queued or changed Mac coding or browser task, or an Aside memory lookup. The executor then polls every lane at once. A wake carries no work and grants nothing; assignment, cancellation and reports still use the authenticated poll and report routes.

Polling depends on state:

| State | Poll interval |
| --- | --- |
| A command, coding run or browser run is active, or results wait for delivery | `pollIntervalMs` (default 1 second) |
| Idle, wake socket connected | 5 minutes, or at once on a wake. The Aside lane sends summaries on this beat. |
| Idle, wake socket down or coordinator unreachable | 15 seconds |
| No wake channel (embedded use, as in tests) | `pollIntervalMs` |

The executor sends `ping` every minute. The coordinator's runtime answers `pong` without waking its Durable Object, so an idle connection adds no requests or duration there. The runtime can also answer for a socket the object no longer holds. This was seen when a deploy restarted the object just after the executor connected. So the first keepalive after connecting, and every tenth, is `hello`, which only the object answers, with `ready`. That wakes the object about 144 times a day. A missing answer within 15 seconds, or a keepalive timer that fires a minute late (the Mac slept), replaces the socket. A lost socket reconnects with a growing backoff of up to a minute, and every connect is followed by a poll. The coordinator treats a socket without a ping for three minutes as stale.

Idle, the executor makes a few hundred requests a day instead of several per second, and the coordinator can hibernate between jobs. The log records `wake_connected` and `wake_disconnected` with timestamps.

### Browser login export

`browser-export-enable --export-config PATH` runs the [browser login exporter](browser-access.md#one-way-snapshots) as one more executor lane, in place of a separate `npm run browser -- watch` process. The executor config stores only the path. The exporter keeps its own private config, browser-sync credential, Keychain-authorized helper and `refresh.sqlite`, so the coordinator still sees two roles with disjoint privileges. The lane runs the exporter's scheduled sync in the background, so it never delays the other lanes. It runs at most every 5 minutes, and at once after a wake; the coordinator announces each newly approved snapshot request. Each site keeps its six-hour refresh. `browser-export-disable` removes the path and keeps the exporter's files.

### Login item

`npm run mac -- service-install` runs the executor as a per-user launchd agent, `dev.umpi.executor`. It bundles `src/mac/cli.ts` with esbuild into `~/Library/Application Support/Umpi/executor/umpi-executor.mjs` and runs it with the installing Node, without a TypeScript loader or npm. launchd starts it through `Umpi Executor.app` in the same directory: a background-only app with an ad-hoc local signature and the bundle ID `dev.umpi.executor`, whose launcher runs Node with the bundle. The plist names that app in `AssociatedBundleIdentifiers`, so Login Items shows "Umpi Executor" rather than Node's signer. It is independent of terminal and Claude sessions and of later edits to the checkout. The agent starts at login and restarts after a crash or a failed start, at most every 30 seconds; an orderly stop stays stopped. Its PATH is the installing shell's PATH, so approved commands and coding tasks find the same tools. Output goes to `executor.log` beside the config, owner-only. The plist holds paths only, never a credential.

Run `service-install` again after updating the code or Node; it replaces the running copy. It refuses while another executor runs, because the daemon lock would make the agent retry. `service-status` reports the launchd state, PID, last exit code, and the bundled commit. `service-restart` restarts it, and `service-uninstall` stops it and removes the plist and bundle while keeping config, journals and log.

### Execution and recovery

The SQLite journal uses WAL and full synchronization. It records start intent before spawn and the terminal result before contacting the coordinator. An identical repeated assignment cannot repeat the command's filesystem effects. Conflicting assignments or completions are rejected.

A command has a detached process group. Cancellation and timeouts send TERM and then KILL after a bounded grace period. Descendants that retain output pipes are also cleaned up after shell exit. Combined captured stdout and stderr are capped at 32,768 bytes, with truncation recorded. Timeouts are failures even if a signal handler exits with code zero. `UMPI_*` and `TELEGRAM_*` variables are removed from command children; other command configuration remains the owner's responsibility.

SIGINT and SIGTERM cancel active execution, preserve the actual result, and make a bounded delivery attempt. A coordinator disconnect alone does not stop the command. Unacknowledged completions are resent without rerunning work.

After a crash, unresolved start intent or running work becomes `uncertain`, with no invented exit code. New execution pauses because an orphan process may still exist. The executor continues to report existing results. It does not kill a potentially reused PID or automatically replay the command. The owner must inspect processes and effects, confirm prior work has stopped, and explicitly resume. The [runbook](../runbooks/local-development.md#recover-an-interrupted-mac) owns that operation.

### Coding execution

The [coding contract](assistant-runtime.md#coding-tasks) owns approval, source limits, continuation, and cloud behavior. [Operation](../runbooks/local-development.md#operate-coding-tasks) owns opt-in and artifact commands. Coding uses separate outbound poll/report routes with the existing executor-only credential and shares one execution slot with individual shell jobs.

The private coding journal records run identity, approved source mapping, private workspace/baseline, operation receipts, and historical artifacts. Source cwd remains the reviewed original location; tool cwd is the private copy. Capture reads selected working-tree bytes without changing the original files or Git index. Each run keeps its baseline and result, so continuation patches refer to successive private baselines, not automatically to the current original checkout. Preserve executor identity, mapping, copies, and journal together. No missing-copy fallback re-captures a changed original.

`coding-enable` and `coding-disable` require exclusive stopped-daemon state ownership. Disabling prevents new coding claims, but does not discard accepted runs, uncertain outcomes, or undelivered results. Status includes opt-in and coding journal state. A coordinator disconnect does not authorize another owner or stop local execution.

Native coding deliberately uses the owner's macOS/Xcode tools instead of local Linux containment. It is **not a filesystem sandbox**. Bash lifetime anchors supervise the owned foreground process group through shell exit, cancellation, and the approved deadline. Deliberately detached/new-group services and effects on external files or networks are not contained or rolled back. Modern macOS `NOTE_TRACK` is deprecated; this contract does not claim kernel child containment. The Linux cloud supervisor has a distinct descendant-reaping contract.

Crash or unresolved start intent pauses both coding and shell admission. Durable operation receipts prevent replay of admitted uncertain effects; preserved results are still reported. Inspect processes and external effects before `resume --confirm-stopped`. Resume records explicit stopped reconciliation without converting an uncertain run into success. An actual stop receipt, pending stop request, and uncertain stop are different facts; task cancellation is not proof of physical shutdown or filesystem rollback.

### Browser execution

The browser lane has its own identity-bound private SQLite journal, lock, site-digest grants, and recovery pause. It polls/reports alongside shell/coding, including cancellation while unavailable; shell/coding ownership does not consume its slot. Default opt-in is disabled. `browser-enable --all-sites` enables approved public-site eligibility without individual grants; plain `browser-enable` uses restricted exact grants and requires at least one. The [browser contract](browser-access.md#owner-approved-tasks) owns public URL and domain scope validation. Changing grants or opt-in requires stopped-daemon ownership and preserves other configuration and prior receipts.

Only task-owned Aside tabs are driven through fixed generated MCP operations. Ordinary stop closes original pages in their owning REPL and proves target absence. Unknown popup descendants or lost REPL ownership stay uncertain; a borrowed attachment cannot close an original target. A stop report distinguishes `stopped: false` from unknown effects after actual closure. Owner resume confirms prior physical stop without replaying or converting effects to success.

[Browser access](browser-access.md#native-aside-lane) owns native action/privacy limits; [operation](../runbooks/local-development.md#operate-browser-tasks) owns grants, opt-in, and recovery commands. Bounded public-page evidence confirms that successful completion follows owned-tab closure. Native Aside is not a network sandbox, and enabling the lane does not reconfigure the Aside installation or unrelated user tabs.

### Aside context

The context lane is an opt-in, read-only bridge to Aside's own derived data. `context-enable` and `context-disable` change it while the daemon is stopped. It runs no model-supplied command and executes nothing on approval. Each tick:

- It polls `/api/executor/context/poll` for owner memory lookups, at most two per tick. It runs `aside memory search --json -n 8 -- <query>` with a fixed argument list, no shell, a 15-second limit, and an environment without Umpi or token variables. It reports at most 8 results of path, title, a 600-character excerpt, date and score.
- Every 5 minutes it reads new completed rows from `context_awareness_summaries` in `~/.aside/u/0/context-awareness/ledger.db`, opened read-only. It sends at most 24 per report: window, title, description, a body cut to 3,000 characters, apps and sites. It never selects the raw events table (clicks, typed text, screen text, page snapshots), which stays on the Mac.
- Its only state is `aside-context.json`, a cursor and last-send time. The cursor advances only after the coordinator accepts a batch.

A failed Aside read is skipped until the next tick and never stops shell, coding or browser work. The Aside ledger is an internal Aside file, so a future Aside update can change it; the reader then sends nothing. The lane runs on every poll; idle, that is every 5 minutes, and a lookup wakes the executor at once. The [runtime contract](assistant-runtime.md#aside-context) owns how the coordinator stores and uses the data.

### Evidence

[Core verification](../learning/assistant-core-verification.md) includes a real command that finished during local Worker downtime, later delivered its saved result, and did not repeat its file write after reconnect. Hosted verification also exercised pending approval, stale-version rejection, a real Mac command, a model completion reply, and executor restart with the same acknowledged completion. Regression tests cover real process groups, deadline handling, crash recovery, conflicting assignments, and private storage boundaries. These checks do not establish a sandbox or prove every external command is idempotent.

## History

- 2026-10-11: Added authenticated outbound execution and a durable journal. Kept uncertain work with its original owner rather than introducing a lease-based duplicate-execution risk.
- 2026-10-13: Added opt-in private-copy coding execution and preserved run history. Documented foreground-group-only native supervision rather than claiming sandbox or detached-descendant containment.
- 2026-10-13: Added an independent opt-in Aside lane, exact site grants, metadata-only status, and truthful original-closure receipts. Kept unknown descendants and lost borrowed-tab recovery under explicit owner reconciliation.
- 2026-10-14: Replaced installed-executor rollout history with the reusable browser opt-in, ownership, and stop boundary.
- 2026-10-22: Added the opt-in Aside context lane: activity summaries every 5 minutes and owner-requested memory searches, with raw activity kept on the Mac.
- 2026-10-24: Added the wake socket and state-based polling, after one-second polling of every lane kept the coordinator awake. Added the launchd login item after an executor started from a terminal session stopped with that session and was not restarted for two days.
- 2026-10-24: Moved the browser login exporter into the executor as a lane, so one login item runs everything and snapshot requests arrive by wake instead of minute polling.
