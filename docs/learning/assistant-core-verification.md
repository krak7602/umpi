---
title: Assistant core verification
aliases: [real model smoke, coordinator restart verification, subscription transport evidence]
updated: 2026-10-19
---

# Assistant core verification

## Current

### Scope and method

Verification combines isolated real-runtime scenarios, regression tests, build dry runs, and bounded reference-deployment smokes. It distinguishes:

- Scripted provider checks from real model inference.
- Local workerd from hosted Cloudflare behavior.
- Synthetic Telegram updates from human-originated messages.
- APNs acceptance from device delivery.
- A stop request from observed process or provider shutdown.
- An acknowledged note upload from delivery to every synced device.

Fixtures use synthetic content and private temporary storage. Credentials, account identities, deployment origins, device identifiers, browser snapshots, screenshots, and personal note contents stay outside the repository and public evidence.

### Core coordinator behavior

The real Worker router, Pi Durable host, Durable Object SQLite state, and Mac protocol exercised:

| Scenario | Observed result |
| --- | --- |
| Model tool turn | The configured subscription model completed a turn and invoked a registered tool |
| Create then correct work | Existing job and reminder identities remained stable while their versions and content advanced |
| Duplicate admission | Repeating the same admission ID and content returned the existing operation; changed content conflicted |
| Version-bound approval | Missing and stale versions did not start a command |
| Conversation during execution | A foreground reply completed while an approved Mac command was still running |
| Coordinator interruption | The Mac retained its result and did not interpret disconnect as cancellation |
| Restart recovery | The saved completion was accepted once and the external fixture effect occurred once |
| Authorization boundaries | Missing, wrong-role, and cross-role credentials were rejected |

These checks establish durable ownership for the exercised cases. They do not prove exactly-once behavior for arbitrary external systems.

### Hosted deployment verification

A bounded hosted reference deployment exercised a Custom Domain with `workers.dev` and preview URLs disabled. Operator-specific resource names and routing remain private.

Observed hosted behavior included:

- Subscription-backed inference through coordinator-owned OAuth.
- Real Telegram ingress and confirmed outbound Bot API acceptance.
- Webhook owner/chat/secret enforcement and duplicate-update reuse.
- Durable reminder firing and separate delivery state.
- Version-bound Mac approval, real command execution, reconnect, and result delivery.
- Protected API rejection for missing and cross-role credentials.
- Eventual Durable Object code cutover after deployment metadata had already advanced.

Synthetic owner-shaped Telegram updates were used for some bounded transport smokes. They exercised real webhook routing, model turns, scheduling, and Bot API calls, but were not represented as new human messages or proof of client presentation.

The deployment exposed one workerd-specific transport issue: `fetch` rejected `redirect: "error"` before request dispatch. The maintained adapter uses `manual`, refuses redirects, and treats unconfirmed responses as uncertain rather than successful delivery.

### Telegram voice-note verification

A bounded OGG/Opus fixture exercised the real Telegram file download, subscription-backed transcription, ordinary Pi input, and text reply path.

Observed boundaries:

- Owner authorization happened before media download.
- The expected speech text reached the assistant.
- Telegram accepted the resulting text reply.
- Replaying the same update did not dispatch transcription again.
- A failed voice item did not block a later text item.
- Raw audio did not enter SQLite, model history, or logs.

The smoke does not establish arbitrary codec/language accuracy, noisy-speech quality, human readership, or provider billing behavior.

### Memory and reviewed context verification

Real SQLite and source-bridge scenarios exercised:

- Selected context present in provider-bound prompts without per-turn retrieval.
- Persistence through Worker restart and transcript compaction.
- Agent-authored proposals excluded from committed memory until owner review.
- Atomic approval/rejection, immutable revision history, and replay-safe decisions.
- Stale review rejection after a newer source edit.
- Topic restoration without replacing unrelated current topics.
- Bidirectional selected-section synchronization that preserved unselected note bytes.
- Visible divergence instead of silent overwrite when native and source edits conflicted.

Fixtures contained synthetic facts. No personal memory content is retained in the repository.

### Proactive scheduling verification

An isolated real workerd process exercised the lifecycle queue, Durable Object SQLite, and protected API. It enabled a disposable scheduler, created a responsibility, scheduled a wake before the next heartbeat, restarted before the deadline, and observed one recovered background admission.

Additional checks covered moved/cancelled wake-ups, stale-version rejection, recurrence and expiry, linked-job coalescing, quiet hours including DST, foreground priority, silent no-action outcomes, and notification deduplication. Scheduling starts paused for new installations.

### Daily-planning verification

Synthetic and bounded provider-backed scenarios exercised:

- Dated briefs, current-day coalescing, and manual versus scheduled preparation.
- Read-only Calendar coverage, OAuth state/PKCE, redirect refusal, and stable event identities.
- Template/current/prior-note projection with protected headings.
- Immutable before/after note-write intents.
- Stale-source conflict instead of overwrite.
- Interrupted post-write synchronization retained for explicit reconciliation.
- Fresh scratch restore, acknowledged Headless Sync, checkpoint integrity, and container stop.

An acknowledged sync is evidence for the client operation, not phone-side receipt or cross-device compare-and-swap. The pinned Headless client has documented concurrent deletion/clearing limits.

### Coding-task verification

The coding paths were exercised with generic repositories and private temporary copies:

| Path | Observed result |
| --- | --- |
| Native Mac copy | Included selected uncommitted source, ran real tools, returned a patch, and left original bytes and Git index unchanged |
| Linux container | Built and ran as a non-root user, restored the approved source, executed a failing-before/passing-after check, and returned only the expected patch |
| Descendant supervision | The Linux supervisor reaped a deliberately detached descendant; the native contract remained foreground-process-group supervision only |
| Deadline and cancellation | Terminal receipts distinguished confirmed stop from uncertainty |
| Cloud checkpoint | The retained archive matched its digest and the provider reported no owned active instance after completion |
| Source export | Only a reviewed generic source archive was uploaded; runners received no model or vault credential |

Mac execution is not a filesystem sandbox. Linux descendant evidence does not generalize to macOS. Source filters exclude known private paths but cannot prove arbitrary source is secret-free.

### Native companion verification

Isolated coordinator and simulator checks exercised:

- Swift 6 app, WidgetKit extension, and native tests.
- Scoped pairing and Keychain-backed credentials.
- Workflow composition, drafts across refresh/restart, stale revisions, replay, and revocation.
- Native command review and device-effect acknowledgements.
- Notification and AlarmKit capability/failure paths.
- APNs request construction, transport acceptance/failure classification, and Live Activity payloads.

A separately authorized physical-device check observed one notification and AlarmKit ringing, including one request registered while the device was reported locked. Public evidence retains only that compatibility result. It omits signing identifiers, device names/tokens, account metadata, exact timing, and the private test timeline. One successful device run is not a delivery guarantee under later throttling, cold starts, or different signing environments.

### Browser integration verification

Browser verification used separate layers:

- Compiled synthetic exporter tests for exact scope, timestamp precision, domain hashes, SameSite/partition handling, OAEP/GCM metadata integrity, and fail-closed parsing.
- Real local Chromium driver tests for observe, refs, fill, click, native Enter, contenteditable, PNG, request policy, stale refs, credential controls, and actual context closure.
- Real native Aside tests against controlled pages, including original-tab ownership and uncertain lost-REPL recovery.
- Hosted Browser Run tests for fixed encrypted snapshot import, public-page observation, provider session identity, targeted destruction, and observed absence.
- Durable expiry/cleanup checks against actual local R2 objects.

The maintained cloud path confirmed owned-session stop after an earlier unconfirmed shutdown remained uncertain and was reconciled without replay. Live-account portability remains bounded by the anonymized [session portability evidence](browser-session-portability.md).

### Subagent verification

Native Pi background delegation exercised:

- Two focused assistant children in separate conversations.
- Parent availability while children ran.
- Automatic immutable report admission and parent follow-up.
- Two coding children inside one already approved private copy.
- Parent integration with a real combined check.
- Patch integrity, original-workspace preservation, and actual native stop.

Regression scenarios cover restart/replay, wrong-parent access, forbidden mutation and recursion, deadline preservation, correction/cancellation versions, capacity, oversized reports, and interrupted application projection. The parent remains responsible for integration and verification.

### Public-source preparation verification

The first-public-commit audit found no usable credential, private key, OAuth token, Telegram token or numeric owner/chat ID, Cloudflare account ID, Apple team/key/app identifier, APNs device token, personal domain, owner name/handle, real deployment origin, or owner-specific absolute path in the candidate set.

Before publication:

- Public Worker and R2 names were changed to explicit placeholders.
- Private OAuth-registration and installed-system history was removed.
- Browser account evidence was anonymized.
- Device evidence was reduced to compatibility claims.
- Ignored private configuration remained mode `0600`.
- App signing defaults used reserved example identifiers.
- Generated icon assets contained no checked owner marker.
- Git had no prior commits, refs, reflog entries, or public history to scrub.

The root MIT license covers project-authored work only. MPL-2.0 Public Suffix List files and the separately distributed `UNLICENSED` Obsidian Headless dependency are identified in [third-party notices](../../THIRD_PARTY_NOTICES.md).

### Model provider verification

On 2026-10-19, the primary model changed to `anthropic/claude-opus-5-5` through Claude subscription OAuth.

- A local Pi turn used Umpi's real assistant and response-style instructions, high effort, and one tool. It made a tool call and then answered from the tool result. Both requests used bearer OAuth, not `x-api-key`.
- Both responses carried `anthropic-ratelimit-unified-5h-*` and `-7d-*` plan quota headers, with `overage-status: rejected` and extra usage disabled. This shows plan-limit accounting on that account. It is not a billing statement.
- The hosted deployment reported the new provider as configured only after the Durable Object code cutover. That took about 4.5 minutes for the code and 5 minutes for the variables, while Mac pollers were active. Credential sync returned HTTP 400 until the code cutover.
- A real hosted control-channel message completed in about 6 seconds, with time and reminder tool calls. The `openai-codex` voice credential remained present.
- Pi issue #10063 reports `Invalid effort level` for accounts with a capped effort. This account accepted high effort, so no workaround was added.

### Automated checks and limits

The publication check passed `npm run typecheck`, 600 Node tests (597 passed, 3 environment-gated skips), and the complete `npm run build` Wrangler dry run with both container images. Root and vault-runtime `npm audit --audit-level=high` reported zero vulnerabilities. All 18 maintained documentation pages were reachable from `README.md` with no missing local target or heading fragment. Candidate-source privacy scanning and the public `/`, `/privacy`, and `/terms` smoke also passed.

Not established by the current evidence:

- General live-call responsiveness.
- Universal authenticated-browser portability or media playback.
- Six hours of unattended browser snapshot ageing.
- Large-project coding performance.
- Exactly-once effects in arbitrary external systems.
- Guaranteed push, alarm, Telegram, or Obsidian delivery.
- Future provider entitlement, rate-limit, or billing behavior.

## History

- 2026-10-11: Established durable coordinator, Telegram, Mac execution, reviewed memory, proactive scheduling, daily-planning, and native-companion evidence.
- 2026-10-13: Added bounded native/cloud coding, browser, subagent, and voice-note verification.
- 2026-10-14: Verified the configured primary model and direct response-style behavior, then replaced private deployment/account/device timelines with bounded public evidence for the first open-source commit.
- 2026-10-19: Verified the Claude subscription route locally and on the hosted coordinator.
