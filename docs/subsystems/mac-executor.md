---
title: Mac executor
aliases: [native execution, execution journal, outbound Mac connection]
updated: 2026-10-14
---

# Mac executor

## Current

### Boundary

`src/mac/` implements an outbound HTTP executor. It does not expose SSH or a listening Mac service. It polls the [coordinator](assistant-runtime.md) with a separate executor credential and advertises canonical workspace roots. The current coordinator dispatches only to an exactly matching advertised workspace.

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
| `pollIntervalMs` | 100–60,000 ms; default 1,000 ms |
| `coding.enabled` | Default `false`; permits separately approved coding-task claims, not automatic task approval |
| `browser.enabled`, `browser.allSites`, `browser.sites` | Default disabled/false/empty; native eligibility opt-in and optional exact local grants, never task approval |

At the default interval, each continuously polled lane makes about 2.6 million polls per 30-day month. Enabled coding and browser lanes add their own poll streams. These are real Worker/DO requests, not a zero-cost or push-only connection. Review shared allowances. Increasing the interval reduces requests but delays assignment and cancellation.

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

### Evidence

[Core verification](../learning/assistant-core-verification.md) includes a real command that finished during local Worker downtime, later delivered its saved result, and did not repeat its file write after reconnect. Hosted verification also exercised pending approval, stale-version rejection, a real Mac command, a model completion reply, and executor restart with the same acknowledged completion. Regression tests cover real process groups, deadline handling, crash recovery, conflicting assignments, and private storage boundaries. These checks do not establish a sandbox or prove every external command is idempotent.

## History

- 2026-10-11: Added authenticated outbound execution and a durable journal. Kept uncertain work with its original owner rather than introducing a lease-based duplicate-execution risk.
- 2026-10-13: Added opt-in private-copy coding execution and preserved run history. Documented foreground-group-only native supervision rather than claiming sandbox or detached-descendant containment.
- 2026-10-13: Added an independent opt-in Aside lane, exact site grants, metadata-only status, and truthful original-closure receipts. Kept unknown descendants and lost borrowed-tab recovery under explicit owner reconciliation.
- 2026-10-14: Replaced installed-executor rollout history with the reusable browser opt-in, ownership, and stop boundary.
