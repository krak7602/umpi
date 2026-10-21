---
title: Personal assistant architecture
aliases: [assistant architecture, Pi Durable candidate]
updated: 2026-10-19
---

## Current

### Purpose and implementation boundary

Build a personal assistant that understands intent, acts on it, and follows through. An infrastructure migration alone is not success. The intended experience is natural conversation, direct useful actions, few unnecessary questions, corrections to existing work, and truthful automatic completion delivery. [Interaction quality](concepts/interaction-quality.md) defines these requirements.

The repository implements a persistent Pi coordinator, text reminders, authenticated Telegram/control interfaces, a private Mac executor, and independent subscription OAuth. Bounded local and hosted reference scenarios have exercised the major paths; operator endpoints and identifiers remain private. Browser refresh is requested-only and encrypted, and public-page checks do not establish arbitrary-site login portability. [Assistant runtime](subsystems/assistant-runtime.md) owns the implemented contract; [core verification](learning/assistant-core-verification.md) owns anonymized evidence and limits.

### Major relationships

- One assistant owns the request and outcome. The implemented coordinator hosts Pi Durable through Cloudflare PiHarness in one owner-scoped Durable Object.
- Proactive follow-through uses the same lifecycle queue for 15-minute reviews, custom deadlines, and linked-job completion events. New installations start paused and activation is explicit. [The runtime contract](subsystems/assistant-runtime.md#proactive-follow-through) separates operational commitments from personal memory.
- Read-only mail follow-through uses the same lifecycle queue for bounded Gmail history checks across one or more mailboxes and a separately owned review that triages mail and records an expiring [situation record](subsystems/assistant-runtime.md#situation-record). A daily [morning brief](subsystems/assistant-runtime.md#morning-brief) summarizes that record with the calendar and plan, and code-owned [default checks](subsystems/assistant-runtime.md#default-checks) send calendar heads-ups and due-soon nudges without model turns. It calls Gmail directly from the Worker, persists provider continuation before advancing the history cursor, and keeps sender, subject, excerpts, summaries, and owner-action state in private Durable Object SQLite. It uses no Worker Cron Trigger, Pub/Sub resource, or always-running container. The [mail contract](subsystems/assistant-runtime.md#read-only-mail-follow-through) owns bootstrap bounds, notification policy, and unavailable mutations.
- Daily-note preparation uses that scheduler. Notes are read and written in the owner's obsy vault through an R2 binding from the Assistant Durable Object, with no container. It is not a coding executor. The [daily-planning contract](subsystems/assistant-runtime.md#daily-note-preparation) owns scoped inputs, direct journal edits, concurrency limits, and the configurable local schedule.
- Telegram supplies desktop and phone conversation through an HTTPS webhook. The native SwiftUI app in `ios/` supplies composed workflows, protected approvals, and acknowledged device effects. The [phone-companion contract](subsystems/phone-companion.md) owns synchronization, capabilities, and verification boundaries.
- The private [Mac executor](subsystems/mac-executor.md) uses outbound authenticated polling and version-bound command approval. Existing local tools remain useful; no replacement of unrelated harnesses is required.
- Approved coding uses a separate durable coding conversation with first-party Pi Durable coding tools. Model OAuth remains solely in the Assistant Durable Object. The opt-in Mac executor captures selected source, including uncommitted changes, into an owner-only private copy and returns a review patch without applying it to the original.
- Native Pi background subagents run focused assistant or coding work in separate owned conversations. They use the parent model, bounded role-specific tools, and durable report projection; the parent integrates and verifies. Coding children share the approved copy and deadline. Browser tasks keep one action owner.
- Cloud coding uses a separate `CodingWorker` container Durable Object and `CODING_ARCHIVE` R2 binding. Only unclaimed work with an exact owner-uploaded source and separate version-bound cloud approval is eligible. Claimed or uncertain Mac work never migrates on silence. [Coding tasks](subsystems/assistant-runtime.md#coding-tasks) owns the contract.
- Browser tasks use a separate durable conversation and independent native Aside lane. Cloud uses fixed, site-scoped encrypted snapshots in isolated Browser Run contexts, not the full Aside app or a coding container. [Browser access](subsystems/browser-access.md) owns approval, authentication, cleanup, and recovery limits; [portability evidence](learning/browser-session-portability.md) preserves anonymized authenticated-session results.

Normal conversation and API-only work should remain container-free. Bound cloud jobs, obtain explicit authorization, and persist artifacts before shutdown. Do not hold a container while waiting for human input. See [Cloudflare Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/).

Linux cannot replace Xcode or other macOS-only work. A cloud executor cannot access unpushed files on a sleeping Mac; the owner must upload the selected source separately. Cloud coding has public dependency internet, but no account credentials, browser login, or macOS capabilities. Source selection excludes private configuration and common secret-bearing files; it is not data-loss prevention or a guarantee that arbitrary source contains no secrets. The owner must review uploads.

Mac coding copies protect the original workspace from automatic edits, not arbitrary native command effects. Native execution is not a filesystem sandbox, and deliberately detached services or external file/network effects are not contained or rolled back. Linux coding uses a real subreaper to stop and reap detached descendants. The [Mac executor](subsystems/mac-executor.md) and [coding evidence](learning/assistant-core-verification.md#coding-task-verification) distinguish these process boundaries.

### Messaging recommendation

The adapter uses Telegram HTTPS webhooks instead of a continuously polling messaging bridge. Ordinary bot messaging does not require Telegram Premium. Bot chats are not end-to-end-encrypted Secret Chats; HTTPS does not change that boundary. The [runtime contract](subsystems/assistant-runtime.md#telegram) defines admission and delivery behavior; [hosted operation](runbooks/local-development.md#hosted-operation) owns live routing and maintenance. See the [Telegram Bot API webhook interface](https://core.telegram.org/bots/api#setwebhook).


### Runtime and version constraints

The runtime choices have different capabilities:

| Component | Documented capability or limit | Integration consequence |
| --- | --- | --- |
| [Pi coding-agent CLI](https://github.com/earendil-works/pi) | Intentionally omits built-in subagents. | Do not assume CLI use supplies application delegation. |
| [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) | Concurrent conversations, forks, ownership, durable/background tasks, and official foreground/background subagent examples. It is experimental. | Native background delegation is integrated; [subagents](subsystems/assistant-runtime.md#subagents) owns application scope and result delivery. |
| [Cloudflare PiHarness](https://developers.cloudflare.com/agents/harnesses/pi/) | Beta. Queues input by default, steers after a tool round, and can detect background completion up to 30 seconds late. | Do not assume its defaults meet live interaction requirements. |
| [Cloudflare Agents SDK `subAgent()`](https://developers.cloudflare.com/agents/runtime/execution/sub-agents/) | Child-agent storage and RPC. | It is not automatically a Pi model-visible delegation tool. |

A coherent version set is pinned and exercised locally and on Cloudflare. [Assistant runtime](subsystems/assistant-runtime.md#pinned-runtime) owns those versions. Pi owns agent orchestration; Agents lifecycle jobs supply wakeups. Coding and browser work use separate durable conversations and restricted task profiles. Native [subagents](subsystems/assistant-runtime.md#subagents) support focused assistant/coding work; calls remain deferred. The [core decision](decisions/2026-10-11-persistent-core.md) preserves earlier reasoning; [coding tasks](subsystems/assistant-runtime.md#coding-tasks) and [browser access](subsystems/browser-access.md) own their current boundaries.

Permissions and approvals, messaging, personal tools, scheduling policy, cross-executor routing, delivery, and device integration remain application responsibilities. The model interprets intent; application code owns operational correctness. Retried admission IDs do not guarantee exactly-once external effects. Calls, messages, writes, and deployments each need explicit ownership and handling for uncertain outcomes. [Interaction quality](concepts/interaction-quality.md) defines task-state and reconciliation requirements.

The coordinator uses subscription-backed reasoning through an independent Umpi OAuth login, with Claude Opus 5.5 on the Claude subscription by default. API-key fallback is disabled; [model authentication](subsystems/model-auth.md) owns provider and billing-route rules. Voice-note transcription uses a separate subscription OAuth grant; general live calls remain optional and must meet the [voice retention criteria](concepts/interaction-quality.md#voice-retention-criteria).

### Cost assumptions

No new agent-platform subscription is a prerequisite. The estimates below assume an existing Workers Paid plan and exclude its base fee from incremental costs; a new installation must include that fee.

A stored future wake-up does not require an active Durable Object or container. Idle objects eligible for hibernation incur no duration charge; outstanding model/API work can keep an object billable for wall-clock time. Alarm invocations, database work, persisted storage, model usage, and any actual container execution still count toward their respective allowances. The 15-minute cadence means 96 scheduled checks per day, not 96 mandatory model turns. Account allowances are shared; no zero-cost guarantee follows from choosing alarms. See [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
Read-only mail checks are short Worker/Durable Object and Gmail API work. Bulk tabs are skipped without model turns, and review batches are packed by size, so model usage scales with actual personal and transactional mail. The default 30-minute poll does not keep a process or container running and does not start a model turn when no candidate thread exists. Gmail API requests, Durable Object invocations/storage, useful triage model calls, and Telegram delivery still consume their respective quotas or allowances.

The chosen cloud coding allocation is one `basic` instance: 1/4 vCPU, 1 GiB RAM, and 4 GB disk. [Cloudflare's container pricing](https://developers.cloudflare.com/containers/platform/pricing/) (updated 2026-10-05) bills active CPU usage and provisioned memory/disk. Beyond all included allowances, one running hour at full allocated CPU adds at most $0.018 CPU + $0.009 memory + $0.001008 disk = **$0.028008 in compute charges** at these rates. This is not an all-in price or spending cap. Model subscription limits, Worker/Durable Object, R2, logs, and egress charges still apply, and allowances are shared with other usage.

Active container time includes waiting for model thinking. Coding activity refresh is bounded by the run deadline; human waiting ends in a retained checkpoint and stop, rather than an indefinitely running instance. See the [coding-task contract](subsystems/assistant-runtime.md#coding-tasks) for lifetime and completion requirements.

The earlier `standard-2` illustration below is **not the chosen coding allocation**. It assumes unused included allowances and full 1-vCPU utilization:

| Monthly running time | Illustrative overage |
| --- | --- |
| 4 hours | $0 |
| 10 hours | About $0.59 |
| 30 hours | About $3.15 |

These are not all-in forecasts. Other account usage consumes shared allowances. Model, storage, Worker/Durable Object, and other charges can also apply. Source: [Cloudflare container pricing](https://developers.cloudflare.com/containers/platform/pricing/).

Browser-only fallback need not use a general-purpose container. Cloudflare Browser Run was exercised through a Worker in the [browser portability investigation](learning/browser-session-portability.md). The [published Workers Paid allowance](https://developers.cloudflare.com/browser-run/pricing/) is 10 browser hours per month and 10 concurrent browsers averaged monthly. Additional usage costs $0.09 per browser hour and $2 per additional averaged concurrent browser. Allowances are shared with other account usage; this is not a final bill.

Browser Run is the browser-only cloud provider. Bounded hosted-model public-page execution and owned-session destruction were observed; [integration evidence](learning/assistant-core-verification.md#browser-integration-verification) owns the limits. It does not replace coding containers or transfer the full Aside agent. No cloud browser is kept alive between tasks; an active browser remains allocated during model thinking and bounded shutdown. Mac polling, approved-request polling, Durable Object work, and encrypted R2 operations still consume shared allowances even without an active cloud browser.

## History

- 2026-10-10: Accepted a persistent cloud coordinator with Mac-first execution and explicit on-demand cloud authorization. The [execution-placement decision](decisions/2026-10-10-execution-placement.md) records the boundary.
- 2026-10-10: Isolated Browser Run experiments established bounded authenticated-session portability; see the anonymized [evidence and limits](learning/browser-session-portability.md).
- 2026-10-11: Implemented the durable text/action core, Telegram, approved Mac execution, proactive scheduling, reviewed context, and the native companion.
- 2026-10-13: Added daily preparation, private-copy coding, source-only cloud coding, separate browser lanes, and native background delegation.
- 2026-10-14: Removed private installation chronology and retained reusable architecture, evidence, and limits for public release.
- 2026-10-15: Added bounded read-only Gmail follow-through with durable page continuation, aggregate triage, separate OAuth, and owner controls.
- 2026-10-19: Moved primary reasoning from the ChatGPT subscription to Claude subscription OAuth without adding a runtime or container.
- 2026-10-19: Added the mail-derived situation record, multiple mailboxes, and the morning brief without new runtimes or containers.
- 2026-10-21: Moved daily notes from the VaultSync container to the obsy vault over an R2 binding, then removed the container.
