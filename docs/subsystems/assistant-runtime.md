---
title: Persistent assistant runtime
aliases: [coordinator, Telegram adapter, reminders, mail follow-through, situation record, morning brief, control API]
updated: 2026-10-19
---

# Persistent assistant runtime

## Current

### Implementation boundary

`src/worker/` implements one owner-scoped Cloudflare Durable Object, `Assistant`, reached through a narrow Worker router. It hosts Pi Durable through Cloudflare `PiHarness`. Pi owns conversations, generation, tool execution, and transcript recovery. The Agents lifecycle queue owns wakeups; application code does not replace its alarm handler.

Implemented actions include text conversation/reminders, proactive follow-through, [read-only mail follow-through](#read-only-mail-follow-through), the [situation record](#situation-record), the [morning brief](#morning-brief), [Aside context](#aside-context), daily-note preparation, approved Mac shell jobs, [coding tasks](#coding-tasks), [browser tasks](#browser-tasks), [native background subagents](#subagents), and the [native companion protocol](phone-companion.md#pairing-tools-and-http-contract). New scheduling, mail monitoring, and native executor installations start disabled. Browser evidence distinguishes native/model execution, encrypted export, and provider stop behavior. Voice calls remain unimplemented, and implementation alone does not prove delivery to a physical device.

### Pinned runtime

| Component | Version |
| --- | --- |
| Node used for local CLIs and verification | 24.21.0; package requires Node 24 or later |
| `agents` | 0.28.1 |
| `@earendil-works/pi-ai`, `pi-durable`, `chord` | 1.1.0 |
| Wrangler | 4.149.0 |
| `@cloudflare/playwright` | 1.3.6; bundled Playwright 1.58.2 |
| Worker compatibility date | 2026-10-10, with `nodejs_compat` |

`package-lock.json` owns the complete dependency graph. Pi Durable and PiHarness are evolving upstream interfaces. Verify the hosted runtime, not just types, when changing their versions. Provider requests use HTTP/SSE rather than a Node-style WebSocket constructor with custom headers.

### Conversation and action ownership

Telegram and the control API have separate persistent Pi conversations. Control-channel verification cannot accidentally deliver its replies to Telegram. Admission uses a caller-supplied message ID. Repeating the same ID and text returns the existing operation; changing its text returns a conflict.

Scoped companion messages join the control conversation with device-bound admission identities. Companion snapshots expose request progress and replies without copying provider/control credentials to the phone.

A state-changing tool records its result and mutation in one synchronous SQLite transaction, keyed by Pi's conversation and task identities. Replaying that tool task returns its recorded result. This does not promise exactly-once effects in external systems.

Every new or edited Mac command starts as `pending_approval`. Approval binds to the exact reviewed version. Editing preserves the job ID, increments its version, and invalidates earlier approval. The model has no approval tool; user prose, choice answers, and command output cannot approve work. A started job retains its executor owner through disconnects. See the [Mac executor](mac-executor.md) for process and recovery semantics.

Completion and its follow-up model operation are committed together. The agent interprets the recorded outcome in a later turn. It need not wait inside the original conversation for the command to finish. This keeps conversation available during Mac execution; it does not guarantee a latency bound for model inference.

Conversation persistence and Pi's automatic compaction are separate from selected core context. Jobs, reminders, and clarification records remain authoritative operational state, not personal memory. Full-vault search and a general retrieval index are not implemented.

### Native core context

`src/worker/core-context.ts` stores `umpi.core-context` as a native Pi Durable session document. It is shared by the owner's Telegram and control conversations, independent of transcript reset and compaction, and backed by the existing Durable Object SQLite storage. All changes use Pi's document API; there is no second database or direct modification of Pi's internal tables.

The registered prompt section reads committed state before each model request, without a retrieval tool call. Its deterministic JSON contains the current revision and selected block IDs, kinds, and text; source metadata stays out of the prompt. There are at most 16 blocks, 6,000 characters per block and 12,000 text characters in total. The supported kinds are background, preferences, and workstreams. An explicit source selection admits content; the runtime does not mine conversations or scan the vault to accumulate a profile.

`read_core_context` exposes the committed revision and source-sync status. `propose_core_context_update` replaces the former direct-write tool: on an explicit request to remember or correct a durable fact, the model may propose text for an existing approved topic, but cannot apply it. A proposal freezes the current revision, complete before-text, proposed after-text, source identity, and reason. Creating or rejecting it changes neither committed prompt context nor the vault. Empty proposed text is an explicit clearing operation, not a special bypass.

Only an authenticated owner decision can approve a proposal. The exact frozen revision and topic must still match; intervening changes make pending reviews stale rather than silently rebasing them. Approval, the single-topic update, its revision-history entry, and the terminal review state commit atomically through native Pi document APIs. Approval marks the accepted text pending for source synchronization. Replayed proposals and decisions do not apply twice; reuse of an identity for a different request conflicts. The model has no approval tool, and prose such as “approved” does not authorize a memory write.

Individual reviews and immutable revision snapshots use native Pi session-scoped document families in the same SQLite-backed storage. History begins at the existing context baseline when the feature first journals it; it cannot reconstruct edits made before that baseline. Both approved changes and changed source imports retain revisions. Unchanged imports do not churn history; unchanged-text proposals are rejected without creating a review. At most 64 reviews may be pending. `read_core_context_history` and the protected history API provide newest-first pages with an exclusive revision cursor, defaulting to 20 entries and capped at 50. History and unapproved text are not included in the automatic core prompt.

Restoration is also reviewed. Selecting an earlier revision and topic creates a new current-before/historical-after proposal; it does not rewind the whole profile or immediately write to Obsidian. The topic must still have the same approved kind and source mapping. Restoring one topic preserves later changes to other topics. Removed or remapped topics require deliberate restoration of their Obsidian source, not silent recreation by a history button. Revision history enables recovery from bad edits; it is not an independent database backup or a guarantee that approved facts are correct.

The protected replacement API checks the complete document's expected revision and normalized source hashes. It accepts only synchronized blocks; omission removes a block. Unchanged imports keep their revision. The memory CLI maps explicitly selected Markdown sections to these blocks and performs three-way synchronization. Owner edits in approved source sections still upload automatically without a model-review step; approved remote corrections replace only their selected section. Unapproved proposals are invisible to this bridge. Changes on both sides conflict. Missing synchronized sources remove their blocks, but a missing source with a pending accepted correction conflicts. No broader vault access is implied.

The bridge checks file identity and content before atomic, permission-preserving replacement, and stops on detected source or revision conflicts. Local writes and the remote commit are not one distributed transaction: an interrupted acknowledgement can leave a completed local edit pending, which the next sync recognizes. Filesystem preflight is not a lock against a non-cooperating editor or an offline device. The owner's vault sync owns cross-device propagation; that delivery is not confirmed by a local file write. See [core-context operation](../runbooks/local-development.md#core-context-and-selected-vault-sections) for bootstrap, watch, and conflict handling.

### Reminders

The model uses semantic tools: `current_time`, `list_reminders`, `create_reminder`, `update_reminder`, and `cancel_reminder`. Relative dates use the configured IANA timezone. Stored deadlines are valid ISO instants with an explicit offset. Creation and correction reject past times.

Reminder identity is stable. Corrections and cancellations require the current version. Due reminders transition to `fired` and create an outbox item atomically. Lifecycle wakeups recover pending and overdue reminders after restart. This is a text-notification contract, not an iPhone system alarm or a hard real-time deadline.

### Proactive follow-through

`proactive-store.ts` owns operational commitments, custom wake-ups, scheduler settings, and review outcomes in the existing application SQLite database. They are not personal memory or a second daily-note system. The existing lifecycle coordinator drives all due work; no Worker Cron Trigger, raw alarm override, or waiting container is introduced. PiHarness's internal recovery heartbeat is separate from the owner's 15-minute review cadence.

A commitment records an actual owner request or explicit assistant promise, its source, next action, blocker, review time, optional linked Mac job, originating channel, and notification permission. Interests and unchecked notes are not automatically converted into obligations. At most 64 commitments and 64 custom wake-ups can be live. Tools list bounded current records and mutate stable identities using their current versions. Purpose, source, and other edits invalidate older reviews and wake-ups. Notification permission is fixed at creation; background turns cannot grant it or create new commitments.

The heartbeat runs every 15 minutes when enabled. It checks persisted eligibility without starting a model when no responsibility needs review. Missed ticks coalesce. A due review time is itself a meaningful trigger; changed external data is not required. Unchanged blocked work with no next review waits for an owner or supported event. Deferred eligibility survives a busy foreground conversation or temporarily unavailable background session. Private last-check reasons and bounded run history explain silence.

Custom wake-ups run independently of that cadence. Each has a future explicit-offset `dueAt`, a later `expiresAt` useful window, and either no recurrence or an interval of 15–525,600 minutes. Only one scheduled/running custom wake can own a commitment. Repeated overdue occurrences coalesce to the next future occurrence rather than replaying a backlog. Expired one-shot work does not run. A linked Mac job completion supplies an immediate event trigger; it replaces the generic completion follow-up for that responsibility and coalesces with a due heartbeat/custom wake.

There is one proactive run at a time. Each channel has a separate persistent background Pi conversation, using the configured model defaults and the normal selected-core prompt. It does not occupy the foreground conversation's Pi input queue. Foreground admission prevents new background effects and preserves interrupted review eligibility. Already submitted operations retain ownership until Pi actually settles; a newer run cannot reuse their session while old tools may still execute. Admission, claims, versions, and application effects are transactional and replay-safe; external delivery is not exactly-once.

Model tools are `list_commitments`, `create_commitment`, `update_commitment`, `list_wakeups`, `schedule_wakeup`, `update_wakeup`, `cancel_wakeup`, and `finish_proactive_review`. Scheduler administration is not a model tool. Background mutations are limited to the current responsibility and its original purpose/source. The runtime also permits existing read-only state tools and permission-gated Mac approval requests. It does not let background turns mutate companion state, ring a phone, create text reminders/choices, or propose memory changes. A new Mac command still needs separate owner approval; its approval card also requires notification permission and non-quiet time.

Each valid review must record `advanced`, `blocked`, `deferred`, `no_action`, or `completed`, with a meaningful private note. Completion requires evidence, not merely a job handle or an unchecked task. No next review means no automatic model retry every tick. A failed or unstructured turn stops implicit recurrence and remains inspectable, unless the commitment has a retry policy; an explicitly recorded foreground interruption instead preserves useful eligibility.

A commitment may carry `retry: { everyMinutes, maxAttempts }` (15–1440 minutes, 1–10 attempts). When a review fails, ends without a structured result, or expires before it starts, and the commitment is unchanged, the scheduler runs it again after `everyMinutes`, at most `maxAttempts` times. This covers a provider outage or an exhausted subscription usage window. A one-time wake retries only inside its own useful window. A recurring wake keeps its rhythm; a separate retry is added only when the next occurrence is later than the retry. The failed run's note records the attempt and time. `failedAttempts` counts toward the limit without changing the commitment version. A structured report, an owner edit, or an exhausted limit resets it. Background reviews cannot change their own policy. The morning brief and daily-note preparation retry every 60 minutes, at most 3 times. Mail follow-through has no policy because it polls every 30 minutes anyway. A failed run's note gives the model failure cause, for example `Model turn failed: Claude rate or usage limit reached (HTTP 429): …`. When a commitment with a policy stops retrying, the owner gets one Telegram notice per commitment per local day, with the cause and, for the brief and daily note, the command to try again. Background final text/errors are never automatically delivered or copied into companion activity. Quiet reviews do not cause phone-push revision churn.

An optional structured notification requires the commitment's original permission and a useful non-`no_action` outcome. Identical notification text for the same commitment is suppressed. Configured quiet hours use the owner's IANA timezone, including daylight-saving transitions; they limit interruptions, not silent review. Notifications are deferred only while still relevant and within the run's useful window. Custom runs inherit their explicit expiry; heartbeat/event runs have a 15-minute window. Owner edits, cancellation, expiry, or changed permissions invalidate unsent updates. Pausing or entering quiet time can hold an already-enqueued update without blocking unrelated deliveries. The transport rechecks each part before sending; it cannot recall a send already in flight.

Scheduler settings start paused. `/schedule` offers owner-only native Enable/Pause controls; `/status` includes a compact summary. Controls bind to a confirmed Telegram message and the exact settings version. Pausing retains responsibilities and stops proactive runs/notifications, not existing text reminders, approved Mac work, or device alarms. The protected control API also configures quiet hours. [Operation](../runbooks/local-development.md#operate-proactive-follow-through) owns activation and recovery.

Ordinary reviews can inspect selected core context and implemented job/reminder/companion state. Only explicitly owned subsystem reviews receive daily-planning or mail tools. A generic wake-up does not confer calendar, vault, mailbox, or browser capabilities.

### Read-only mail follow-through

`mail-store.ts` owns a separate operational inbox view in application SQLite. It is not standing memory, a daily note, or a copy of the full mailbox. Settings start paused and require the existing proactive scheduler. The default poll is 30 minutes and is configurable from 15 minutes to one day. Lifecycle deadlines invoke short Worker/Durable Object work; there is no Cron Trigger, Gmail Pub/Sub resource, polling process, or always-running container.

`UMPI_GMAIL_CREDENTIALS` holds one grant (the `primary` mailbox) or an `accounts` list of up to four separately authorized mailboxes. Each mailbox has its own bootstrap boundary, history cursor, and continuation in `umpi_mail_accounts`; thread identities include the mailbox, and the primary mailbox keeps its original identities. A mailbox added while mail is enabled starts from the current lookback window. Existing single-mailbox state migrates into the `primary` row.

Enabling requires an owner-selected fixed bootstrap boundary from now through the previous 30 days; `/mail` offers now, 7, 14, and 30 days, with 14 days as the default setting. That boundary never moves backward automatically. Each provider invocation lists a bounded page and hydrates at most 50 thread contexts. If more messages or history records exist, `mail-store.ts` persists the provider page token and any bounded message-ID queue in SQLite, then schedules the next page 20 seconds later. One page costs roughly 1,000 Gmail quota units; reads within a page are paced to ten per second. Gmail's per-user limit is a moving average of 250 units per second, and pages five seconds apart exceeded it in hosted use. It retains at most the latest eight bounded messages per selected thread. A provider response that exceeds the 1,000-ID continuation bound fails without advancing coverage.

Bootstrap and incremental synchronization commit a new Gmail `historyId` only after every saved page and queued message ID has drained. A restart resumes the exact continuation. Bootstrap listing excludes Gmail's promotions, social, and forums tabs in the search itself unless a message is important or starred, which avoided about 28% of reads on real mail. Incremental history cannot filter by search, so threads whose latest incoming message is in those tabs are also ignored in code without a model turn, unless Gmail marks them important or the owner starred them. Model review then reads one batch packed to at most 36 KB and 40 threads. Pi truncates tool results above 50 KB; an earlier fixed 50-thread batch exceeded that, so the model saw a partial list, its commit was rejected, and reviews failed without progress. Multiple triage turns accumulate structured decisions and produce one final digest, not one alert or digest per batch. There is no cap on how many threads may notify; the digest lists the newest 15 and states how many more are in `/mail`. The digest shows only the subject, sender display name, local received time, and suggested action; `/mail` owns the detailed review. No continuation overflow is silently discarded.

Duplicate provider versions do not reopen an item. A later incoming message reopens handled or ignored state; a later sent message resolves a thread whose latest incoming message was answered. An expired Gmail history cursor stops polling and requires an explicit bounded re-bootstrap. Provider failures remain sanitized and never become an empty successful inbox. An interrupted saved continuation retries after one minute; failures without saved progress retry at the configured poll interval.

The Gmail OAuth credential is independent from Calendar, even when both use the same owner-controlled Google Cloud project or installed-client JSON. It requests only `gmail.readonly`. Refresh and API requests use fixed Google HTTPS endpoints, reject redirects, and do not expose account identity or provider error bodies. The adapter reads inbox/history metadata, bounded snippets for up to eight selected messages, and the latest unanswered incoming body. `mail-text.ts` cleans that body before storage: HTML (preferred when present) becomes line-structured text with `html-to-text`, quoted replies and simple signatures are trimmed in code (the `email-reply-parser` package probes the file system at load, which Workers reject), raw URLs become their host name, invisible preheader padding is dropped, and a trailing unsubscribe or legal footer is cut. At most 2,500 cleaned characters are kept. It does not download attachments. Restricting full-body hydration to that latest incoming message and pacing reads keeps each bounded page below Gmail's per-user request-rate quota. If that body exceeds the response bound, its provider snippet remains usable and cursor progress continues.

Pending thread context, sender, subject, timestamps, Gmail URL, summaries, reasons, and owner-action state are private Durable Object records. The explicitly owned Pi review receives only the bounded pending batch. Mail text is untrusted data, never instructions or authorization. Ignored and resolved items clear message excerpts; marking an item handled also clears them. Selected attention items retain bounded context so an owner can request a proposed reply in chat. The model provider receives the selected batch for triage, and Telegram receives the resulting digest or owner-requested draft text.

The structured triage tool must decide every version-bound item as `notify` or `ignore`, and it records [situation facts](#situation-record) from the same batch. A thread already triaged under an older extraction version, or already replied to, is reopened once in `facts` mode when a later scan sees it; it takes outcome `facts_only`, keeps its triage state, and never notifies. Invalid facts are rejected individually and reported without discarding the batch. The detailed review rules are returned with each owned batch, not placed in every conversation's system prompt. Application code generates the notification from committed decisions and routes it through normal proactive permission, quiet-hour, deduplication, and expiry checks. No model prose can widen the scan or notify outside those checks. `/mail` binds settings and item actions to the exact confirmed Telegram message and versions. It supports pause, check now, bounded re-bootstrap after cursor expiry, draft-in-chat, 24-hour snooze, and handled. These actions change only Umpi state.

Gmail mutation is intentionally unavailable. Umpi cannot send, save a Gmail draft, mark read, archive, delete, or change labels. A proposed reply is only chat text for owner review. Foreground `read_mail_follow_through` reads selected operational status; only the owned background review can call `read_mail_triage_inputs` and `commit_mail_triage`. Generic commitment and wake tools cannot repurpose the mail-owned responsibility. [Mail operation](../runbooks/local-development.md#operate-read-only-mail-follow-through) owns authorization, secret installation, activation, revocation, and verification.


### Situation record

`situation-store.ts` keeps expiring, structured facts about the owner's current life in application SQLite: orders, spends, subscriptions, bills, job applications, bookings, account alerts, and other time-bound updates. It is operational state, not standing memory. Mail review is currently the only writer.

Each fact has a stable identity derived from its kind and a normalized key, such as a merchant and order number or a company and role, so later mail updates the same fact. Older evidence fills missing fields but never regresses a newer state. Facts keep up to eight state transitions and five source links, but no message bodies. Expiry is code-owned per kind and state, capped at 180 days; spends last 45 days. At most 2,000 facts are kept.

Spending totals for today, yesterday, the last 7 days, and the last 30 days, plus the top payees, are computed in code from spend facts in the owner's timezone, never by the model. They only cover alerts that arrived by mail.

Foreground tools are `read_situation` (bounded by bytes, urgent items first), `update_situation` for an owner correction or dismissal, and `read_calendar` for up to 14 days of read-only calendar. An owner state correction stands until newer evidence arrives after it. Background reviews cannot call these tools. The protected `GET /api/situation` returns the same view.

### Morning brief

`brief-store.ts` schedules one owner-enabled brief per local day, by default at 03:30, using the existing lifecycle scheduler and follow-through settings. Enabling after that day's time starts the next day. A delayed alarm sends the current day's brief once and never builds a backlog. The owned background review calls `read_brief_inputs` (today's and tomorrow's calendar, today's prepared plan and owner intent, reminders due within 36 hours, mail needing the owner, the situation record, and which facts changed since the last brief) and then `commit_brief` with text or `null`. The delivered notification is generated from the committed text, so model prose cannot widen it, and a `null` brief stays silent. Normal proactive permission, quiet-hour, and duplicate rules apply. A failed brief turn is retried every hour, at most three times (see [proactive follow-through](#proactive-follow-through)).

`/brief` shows status with **Brief now** and Enable/Pause controls bound to the confirmed message and settings version. The protected API provides `GET /api/brief`, `PUT /api/brief/settings`, and `POST /api/brief/run`.

Background conversations, which run mail review, the brief, daily preparation, and commitment reviews, use medium effort. Owner conversations use high effort.

### Aside context

`activity-store.ts` keeps what the Mac's [Aside context lane](mac-executor.md#aside-context) sends. The executor credential authorizes it, and one Mac owns the lane; another executor ID is refused until the current one has been quiet for 10 minutes.

- **Activity summaries.** Aside writes them every 10 minutes from what the owner does on the Mac. They are kept for 14 days and upserted by Aside's summary ID. `read_activity` lists one local day oldest first, with local times, titles, descriptions, apps and sites, and with `detail` the longer bodies, within 24 KB, keeping the newest entries. The morning brief receives yesterday's titles and descriptions (6 KB) as `yesterdayActivity` and may add a line on what the owner mainly worked on.
- **Memory search.** `search_aside_memory` queues one query of up to 300 characters, and waits up to 20 seconds for the Mac's answer. It returns at most 8 excerpts, or says the Mac did not answer. A lookup not claimed within 30 seconds is not sent later. Records are deleted after an hour.
- Both tools are for the owner's own conversation; background reviews other than the brief do not read Aside data. Results are context written by another system, not instructions. Lasting facts go through the reviewed `propose_core_context_update`.
- Summaries and search results are sent to the model provider like any other conversation content. Raw Aside activity is never sent. `GET /api/status` shows `activity`: the Mac's last poll, the last summary report, and the stored range, without content.

### Default checks

`alerts.ts` adds three owner-default checks that run whenever follow-through is enabled. Two of them send templated Telegram text without a model turn.

- **Calendar heads-up.** The calendar for today and tomorrow is read every 20 minutes into a cache. Each timed event gets one message `calendarLeadMinutes` (default 15) before it starts. A failed read keeps the previous cache instead of looking like a free day. All-day events are skipped.
- **Due-soon nudges** from the [situation record](#situation-record), once per item and due time: a bill at 09:00 local the day before it is due, a subscription at 09:00 two days before it renews, a timed interview, assessment, or booking one hour before, a date-only deadline at 09:00 the day before, and an order when it becomes out for delivery. Terminal or dismissed facts never nudge, so an owner correction such as "paid" stops it.
- **Stalled commitments.** An active or blocked owner commitment with no next review time, no live wake, and no update for two days receives one ordinary proactive review per commitment version. Mail, brief, and daily-note responsibilities are excluded.

Heads-ups inside quiet hours are dropped because they are time-bound; nudges wait until quiet hours end while still useful. Sent keys are kept for 60 days to prevent repeats. The protected `GET /api/alerts` and `PUT /api/alerts/settings` read and change `calendarLeadMinutes` (0 turns heads-ups off), `dueSoon`, and `stalled`.

### Daily-note preparation

`planning-store.ts` keeps per-day briefs, preparation status, captured source evidence, applied-entry identities, and immutable note-write intents in application SQLite. These are operational records, not automatic additions to standing personal memory. Scheduling starts disabled, at a configurable local `02:30`; the existing follow-through scheduler must also be enabled. Its durable lifecycle deadline prepares only the current local day, coalesces missed days, and does not keep a model or container running between deadlines. An early manual preparation does not consume the later scheduled preparation. A failed preparation turn is retried every hour, at most three times, inside the same day, before the day is marked blocked.

Inputs are the current dated note, current template, at most three previous existing dated journals, the latest explicit brief, native approved core context, and fresh authorized calendar data. Briefs cover today or the next seven days and use expected versions. Current owner corrections take precedence over standing preferences. The planner must select a manageable subset, preserve rest/free thinking, distinguish targets from confirmed events, and never invent workdays, meetings, or completed outcomes.

The Google Calendar adapter has a separate grant for only calendar-list and event read scopes. It selects the primary and selected non-hidden calendars, bounds fan-out/pagination, filters cancelled/self-declined events, and retains tentative/all-day distinctions and stable instance identities. Missing, incomplete, or inaccessible sources produce explicit coverage gaps, not an apparently complete empty schedule. Credentials from unrelated clients are not imported.

Calendar requests use workerd-supported manual redirect handling. A token or Calendar API redirect is rejected without following it or forwarding credentials to its target.

The merge changes only unchanged previously applied lines or adds identified entries under Schedule, Tasks, and Links. Checked, edited, or removed contributions remain owner-controlled; their retained baselines prevent silent recreation. The main date title follows the current template. Notes and Done / changed are not planning destinations, including protected descendant headings. Calendar identities and retained entry IDs survive wording changes; the model must reuse them rather than invent replacement identities.

A background tool captures inputs, then persists an exact before/after intent before dispatching any filesystem effect. Brief/core revisions, current-day expiry, foreground priority, settings, and the owned review are checked again. External sync never runs inside a SQLite effect transaction. A completed model turn is not a completed note write. Unconfirmed uploads retain the exact intent for explicit same-day reconciliation; source changes require review rather than a replacement patch or automatic retry loop.

#### Note storage

Notes live in the owner's obsy vault. When the `OBSY_LIBRARY` R2 binding and `UMPI_OBSY_PREFIX` are configured, `obsy-vault.ts` reads and writes the [obsy](../../vendor/obsy/README.md) vault directly from the Durable Object through the `@obsy/agent` SDK. No container runs and no device key is used. A snapshot reads the day's note, the template, and the newest three earlier `YYYY-MM-DD.md` notes directly in the journal folder (1 MiB in total; a note that is not UTF-8 text stops planning). A write reads the note again. It reports `synced` when the note already holds the intended text, which also covers a retry after a lost response. It reports `conflict` when the note changed after planning. Otherwise it checks expiry and calls `replaceIfUnchanged` with the revision it read: a compare-and-swap on the bucket's log across every device and agent. A change between that read and the commit is also a `conflict`, and nothing is written. Any error is `unconfirmed`; resuming the same intent is safe. Commits record `actor: { kind: agent, id: umpi, run: <intent ID>, toolCall: <intent ID> }`. Devices merge them into an open note, so umpi does not wait for presence. The owner can reverse one with `obsy undo <seq>`. obsy limits an agent to 240 commits and 40 files per hour; umpi's volume is far below that. An invalid prefix disables notes and is reported as `planning.backendIssue`. The vendored packages and how to update them are described in [vendor/obsy](../../vendor/obsy/README.md).

Scope is `journals/` and `templates/date-template.md`. Notes are bounded to 256 KiB. Model access is limited to the dated-note/template projection; the R2 binding is never shared with the coding container.

#### Journal writes after preparation

`journal.ts` keeps the daily note current after the morning plan, without model turns. It owns three kinds of lines, each with an `umpi-plan` marker so a retry never duplicates and owner lines are never edited:

- **Close-out.** Once a day, after the preparation time, yesterday's `Done / changed` receives factual lines from recorded state: timed meetings from the calendar, completed owner commitments, [situation](#situation-record) state changes (deliveries, applications, renewals, payments, bookings, account alerts), one spending total with the largest payments, and mail that needed the owner. A bill that only became due is not recorded as something that happened.
- **Intra-day additions.** New timed calendar events for the rest of today, from the [default checks](#default-checks) calendar cache, are queued as schedule lines using the same event identities the planner uses, so they never duplicate a planned line. The foreground `add_to_daily_note` tool queues an owner-requested line for tasks, schedule, done, notes, or links within seven days of today.
- **Check-ins.** At each configured local time (default 13:00 and 18:00, within a two-hour window), the current note's Tasks section is read and one Telegram message reports done versus open tasks. A note without tasks sends nothing.

Owner sections are written only by these code paths; the planner model still cannot target `Done / changed` or `Notes`. New lines follow the owner's last line in that section, and a missing section is appended. Routine additions are written at most hourly per note, and owner requests or the close-out on the next coordinator pass. Today's note is never written while morning preparation holds its inputs. A conflict or unconfirmed upload retries from the current note after ten minutes, up to five attempts. Vault work runs as tracked background work so the coordinator does not wait on the container. The protected `GET /api/journal` and `PUT /api/journal/settings` read and change `closeOut`, `intraDay`, and `checkIns`.

For questions about today, the assistant reads today's note first and uses the calendar for events added after preparation.

Foreground tools are `read_daily_plan`, `set_daily_brief`, and `prepare_daily_plan`. A saved plan is historical preparation evidence; `read_daily_plan` with `refresh: true` reads the current note for today or the previous seven days, without claiming a fresh calendar. Only the owned review can call `read_daily_planning_inputs`, `commit_daily_plan`, and `resume_daily_plan`. Generic scheduling tools and HTTP mutations cannot repurpose its commitment or wake. Daily preparation grants no alarms, calls, reminders, calendar writes, memory edits, or general file access.

`/plan` provides native prepare-today and Enable/Pause controls bound to the exact confirmed message, date, settings, brief, and plan versions. Normal successful preparation is quiet. Owner control routes expose status, briefs, retained before/after writes, cancellation, and explicit release after review. Cancellation cannot retract dispatched I/O; release is not rollback, and a late actual receipt remains recorded. [Operation and activation](../runbooks/local-development.md#operate-daily-note-preparation) owns the setup procedure and remaining provider verification.



### Telegram

`POST /telegram/webhook` requires the configured secret header, exact owner ID, exact chat ID, and a private non-bot sender. It handles ordinary text, voice notes, images, native callback queries, `/status`, `/pair`, `/memory`, `/schedule`, `/plan`, `/brief`, `/mail`, `/code`, `/browse`, `/approve ID VERSION`, and `/cancel ID [VERSION]`. `/status` is a bounded readable summary, not JSON or a guarantee that the Mac is online. `/pair` sends a short-lived companion pairing code outside Pi and the durable plaintext outbox; webhook replay does not mint another code. `/memory` opens owner review and revision history; `/plan` controls daily preparation; `/mail` controls [read-only mail follow-through](#read-only-mail-follow-through); `/code` opens [coding-task controls](#coding-tasks); `/browse` opens [browser-task controls](#browser-tasks). Group chats remain unsupported. [Images and other attachments](#images-and-other-attachments) have their own rules.

Voice notes become ordinary owner input after real [subscription-backed transcription](model-auth.md#voice-note-transcription). Replies remain text; this does not add live calls. Telegram's native voice recorder needs no new bot command or BotFather configuration.
Successful conversational Pi replies keep their standard Markdown in the durable operation result and on non-Telegram channels. The Telegram projection parses that Markdown locally into plain text plus Bot API entities for headings, emphasis, lists, code, block quotations, tables, and safe links. It does not ask Telegram to parse Markdown or HTML, so literal source characters and raw HTML cannot break the request. Unsafe link schemes remain unlinked text. Entity offsets are projected across the existing Unicode-safe message chunks.

Audio is limited to five minutes and 8 MiB, with a 16,000-character transcript and eight pending ordinary Telegram messages. Admission authenticates the owner before media processing. The download helper accepts only Telegram's fixed Bot API hosts, validates file identity, path, actual size, and OGG/MP3/M4A container identity, and follows no redirects. Raw audio stays in a bounded ephemeral buffer and is cleared after processing; it never enters SQLite, model context, or logs.

The durable inbox preserves text/voice admission order. Pending transcription counts as foreground input before a Pi operation exists, fencing background mutations and interruptions. Native controls bypass the inbox, so approval and cancellation remain usable. A transcript never enters the bot-command dispatcher or becomes an approval. The original Telegram send time accompanies the model input for relative dates; a caption stays separate as owner context.

One update ID binds immutable input, one transcription dispatch, and normal Pi admission. Download can recover before transcription; a restart during possibly performed transcription fails visibly rather than repeating it. Actual speech text persists before Core delivery, which can recover under the same identity without re-transcription. Empty, oversized, unavailable, or interrupted speech produces a readable error and releases later messages, never a placeholder model input. Protected `telegram.voiceNotes` status reports the model, credential presence, bounded queue metadata, and outcomes; credential presence is not connectivity proof.

#### Images and other attachments

A photo, or a JPEG, PNG, WebP or GIF sent as a file, becomes owner input with its caption. For a photo, the webhook selects the largest Telegram size whose longest side is at most 2,000 pixels and whose size is at most 1 MiB. An album becomes one owner message: its first image waits two seconds for the rest, and up to four images share one 1 MiB limit. Images that do not fit are counted, and the model says they were not used. The download uses the voice-note helper. The image format comes from the actual bytes, not Telegram's declared type.

Image bytes are not kept in the inbox. If an image message is interrupted or not confirmed, the inbox downloads it again. After three unconfirmed attempts, the image fails with a reply so that later messages are not held. `umpi_operation_images` holds the base64 images only from admission until Pi accepts the message. After that, Pi's transcript holds them like any other user message content. An image over the limit, or bytes that are not an image, get a readable reply and no model turn.

Umpi does not read videos, video messages, GIF animations, audio files, other files, stickers, locations, contacts, or polls. With a caption, the attachment is skipped and the caption is ordinary owner input; the model input says what was skipped, so the reply mentions it briefly. Without a caption, Umpi sends one fixed reply and starts no model turn. Service messages, such as a pin, are ignored. None of these is rejected with an HTTP error, so Telegram does not redeliver them.

The owner's Telegram command menu lists argument-free `/pair`, `/status`, `/memory`, `/schedule`, `/plan`, `/brief`, `/mail`, `/code`, and `/browse` actions. Job approval/cancellation remains on contextual buttons. The command list is maintained in source and published through the Bot API after successful deployments, with readback verification; it is not model-authored per turn. [Menu operation](../runbooks/local-development.md#maintain-the-telegram-command-menu) owns synchronization and recovery. Menu visibility does not grant authorization or bypass webhook owner checks.

Memory cards show complete before/after content and native Approve/Reject buttons. Long reviews use ordered Unicode-safe chunks; all chunks must have confirmed delivery, and the button must match its exact message, before a decision is accepted. History navigation exposes per-topic reviewed restores, not an immediate rollback button. Durable UI projection and replay-safe native decisions recover across the separate Pi and outbox commits. Failed or uncertain card delivery is not automatically retried; `/memory` provides an explicit fresh review path. The trusted review surface is Telegram or the control API, not agent-authored phone forms.

Approval cards prioritize the exact command in a native code block. The working directory has its own normal-text location block with the final folder name emphasized. A compact line states the human-readable timeout and that execution is not sandboxed. Internal IDs, version counters, and manual command syntax stay out of the Telegram card; protected job status retains them. Telegram entities—not Markdown/HTML parsing—preserve literal command characters. Long cards preserve all command/path text and format spans across Unicode-safe chunks, with buttons only on the final confirmed chunk.

Native approval tokens are opaque persisted bindings to one job version, action, and confirmed Telegram message. Authorization uses the person clicking, not the bot that authored the card. A stale version, wrong message, unknown token, or unconfirmed delivery cannot approve work. Repeated clicks do not repeat the action. Approval retains Cancel while work remains active; running cancellation remains a request until the Mac reports its actual outcome. Callback acknowledgement and keyboard-edit failures cannot undo the committed action.

`create_choice` posts one clarification with 2–5 options. A new question supersedes the previous pending question in that conversation. A button selection atomically records the answer and admits one model operation; duplicate selection reuses it, while conflicting or superseded selections fail. The next ordinary message, including transcribed voice, can answer in the owner's own words, retaining the question/options in its model input. Slash commands, other conversations, and background job completion do not consume the question. Answered keyboards are cleared best-effort. Successful model turns with no final text do not create an extra diagnostic message; failures still produce a reply.

Outbound messages use the real Telegram `sendMessage` API. Text is split without breaking UTF-16 surrogate pairs. An outbox item moves through `pending`, `sending`, and then `sent`, `failed`, or `uncertain`. Proactive items can also be `held` while paused/quiet or `cancelled` when no longer relevant; neither is a confirmed send. A restarted in-flight send becomes uncertain. Failed or uncertain sends are not automatically repeated, and later chunks in that message cannot pass them. The owner must inspect the chat before any manual resend.

Control-channel outbox items remain in coordinator SQLite for API readers and are marked `sent`; that status does **not** mean Telegram or a phone received them. The configured bot is paired to one authorized owner and private chat; bot identity, numeric IDs, and tokens remain in private configuration. The webhook uses the same hostname as the protected API. [Hosted operation](../runbooks/local-development.md#hosted-operation) owns the deployment configuration; [verification evidence](../learning/assistant-core-verification.md#hosted-deployment-verification) distinguishes real Telegram ingress from authorized synthetic webhook checks.

Telegram fetches use `redirect: "manual"` because workerd rejects `"error"` before making the request. Redirects are not followed, and an unconfirmed response cannot become a successful delivery.

### Coding tasks

Coding is opt-in and requires separate native or cloud authorization. Bounded reference scenarios returned review artifacts without applying changes to original source and confirmed cloud checkpoint/stop behavior. [Operate coding tasks](../runbooks/local-development.md#operate-coding-tasks) owns commands and rollout gates; [verification evidence](../learning/assistant-core-verification.md#coding-task-verification) owns observed outcomes and limits. [Mac execution](mac-executor.md#coding-execution) owns native storage and process limits.

An explicit foreground owner request can create a complete coding task. Approval binds the current version, task prompt, exact canonical source cwd, and a deadline of at most one hour. This authorizes bounded tool execution for that task, unlike an individual shell-job approval that authorizes only the displayed command in its original cwd. Existing shell-job semantics do not change. No background task can approve itself or start coding.

The host selects only the `umpi` extension by default. A separate durable coding conversation uses pinned Pi Durable 1.1.0 first-party CodingTools `read`, `write`, `edit`, and `bash`, plus task read/finish and [scoped delegation](#subagents) tools. Its profile excludes core context, personal notes, calendar, companion capabilities, browsers, and calls. Model OAuth and refresh remain solely in `Assistant`; runners receive no model credentials. External harnesses and installed applications do not change.

Native approval captures current Git-selected tracked and safe untracked working-tree bytes, including uncommitted source, read-only. Execution uses an owner-only private copy with a generic Git baseline, not the original checkout. Results are review patches; there is no automatic original edit, stash, reset, checkout, commit, push, merge, or patch application. Cancellation stops authority, not external effects, and is not rollback.

First-party `write` and `edit` reject destinations that normalize outside the approved private copy. This is an automatic file-tool boundary, not a filesystem sandbox: native `bash`, indirect links, and external effects still require careful task scope and review.

Stable-ID corrections steer an active run at its next tool boundary without changing its owner, copy, or deadline. A settled continuation needs fresh approval and a new bounded run while retaining the coding conversation. Native continuation stays on the same executor and copies the acknowledged prior private copy through `sourceRunId`; cloud continuation restores an explicit checkpoint. Missing prior copies fail without fallback. Per-run results, patches, and checkpoints remain historical evidence. Incremental patches must be reviewed in baseline order.

An offline Mac leaves unclaimed work queued. Cloud execution can be offered **only for unclaimed work**, with separately version-bound owner approval of an uploaded source ID, exact cwd, digest, and capture time. Claimed or uncertain native work never migrates because of silence. Cloud cannot assume that unpushed files on a sleeping Mac exist remotely: source upload is a separate owner action.

Source selection excludes Git history, ignored files, dependencies/generated output, private configuration, `.env`, keys, and account data; normal implementation names such as `credentials.ts` remain eligible. Selection is not DLP or a guarantee that arbitrary secrets are absent. The owner reviews source before export. Limits are 8 MiB selected content, 12 MiB decoded gzip JSON, 32 MiB compressed transport, 4,096 selected files, and 8 MiB patch. Bounds fail truthfully, not by truncating a successful result.

Whole-file/write/binary RPC transfers are bounded to 4 MiB; retained shell text to 128 KiB and byte windows to 64 KiB. Output is bounded to 16 MiB per command and 64 MiB per run, with 64 handles, 4,096 operations, and approximately 128 MiB journal plus baseline. These are operational bounds, not an invitation to split an oversized source export.

The separate Linux `CodingWorker` and `CODING_ARCHIVE` use the appended `v3-coding-worker` migration, preserving `Assistant`, R2 state, and private values. The `v5-retire-vault-sync` migration deleted the earlier note container class. The source-only container has public dependency internet but no credentials, browser login, or macOS capabilities. It uses an actual subreaper/pidfd supervisor to stop and reap detached descendants. Basic allocation is 1/4 vCPU, 1 GiB RAM, 4 GB disk, maximum one instance. Active time includes model thinking; 30-second activity updates remain deadline-bound, with a 90-second idle fallback. Human waiting saves an artifact checkpoint and stops the container.

Completion requires retained artifacts, actual R2 receipts before destruction, real exit-zero checks, and confirmed stop. Unstructured model endings are blocked; genuine issues remain visible. Crash-lost scratch stays uncertain and is not replayed. The no-owner-stop fence forbids late admission. Cloud reconciliation confirms actual stop and preserves uncertainty rather than inventing success.

No new agent-platform subscription is required, but this is not zero-cost or an all-in cost cap. At published [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/), maximum CPU plus provisioned memory/disk beyond shared included allowances is at most $0.028008 per running hour for Basic compute. Actual CPU use, model subscription limits, Workers/DO/R2, and egress still apply.

### Subagents

Native background delegation is available for foreground assistant requests and approved coding runs. It follows Pi Durable's pinned [background subagent example](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/test/examples/23-subagent-background.ts), using owned child conversations and durable Anchor/Reporter tasks. It does not use a second agent framework or Cloudflare Agents RPC as a substitute for model delegation.

The parent has `spawn_subagent`, `message_subagent`, `subagent_status`, and `cancel_subagent`. Each child copies the parent's selected model and thinking level into its separate conversation when spawned or restarted from idle; an active child is not changed mid-run. A focused goal supplies its working context; the parent transcript is not copied. Browser task profiles do not delegate, and children cannot recursively delegate or approve work.

| Parent | Child capability | Responsibility retained by parent |
| --- | --- | --- |
| Foreground assistant | Selected native core context and read-only `current_time`, `list_reminders`, `job_status`, `read_core_context` | Interpret intent, supply missing sources, authorize mutations, integrate the result |
| Approved coding run | First-party `read`, `write`, `edit`, `bash`, and `read_coding_task` in the same approved copy/run | Assign non-overlapping file work, integrate changes, run final checks, finish the task |

Coding authority derives from the exact parent session, task, run, and original deadline, never from model-supplied scope. Every child tool/RPC admission rechecks that authority. Child conversation/task identities remain part of replay identity, so sibling invocations cannot consume each other's receipts. Shared files are coordination, not separate worktrees or a security sandbox.

At most four children are active across both profiles. Default lifetime is five minutes; the maximum is fifteen minutes and never exceeds the coding run's original deadline. Corrections use the stable child ID and expected version. Working corrections steer at a tool boundary without extending the deadline. An idle follow-up gets a new bounded generation; a newly approved coding run gets a fresh scoped child conversation. Parent coding corrections are also forwarded idempotently to its current children.

A native report persists before application admission. The coordinator projects it through the parent's existing durable result/input path using one immutable report identity, then acknowledges that projection. Native and application SQLite transactions are separate; recovery reuses that identity after interruption instead of directly submitting an untracked parent message. Results are untrusted evidence, not authority or proof of external effects. Failed, oversized, superseded, cancelled, or expired results cannot be promoted to successful completion.

Cancellation is version-bound and distinguishes a requested stop from actual native idle. Coding finish waits for children and pending report admission. Closing or cancelling the coding run revokes child authority and joins child model work before retaining artifacts and requesting executor stop; native model idle alone is not an executor-stop receipt.

Subagents reuse the coordinator's subscription credential and lifecycle queue. No new resource or always-running container is required. Extra model calls consume subscription limits; Workers, Durable Object storage, and any active coding container remain metered. [Operation](../runbooks/local-development.md#operate-subagents) owns inspection and cancellation; [verification](../learning/assistant-core-verification.md#subagent-verification) distinguishes hosted execution from isolated recovery checks.

### Browser tasks

`umpi-browser` is a separate durable task profile; it does not inherit coding, personal-context, vault, companion, or arbitrary REPL capabilities. The coordinator owns model OAuth and private snapshot-key state. Browser effects use the independent native Aside lane or the bounded `BrowserWorker` actor, never the coding container. Foreground tools propose/correct/cancel work and offer unclaimed cloud execution; only authenticated owner decisions approve it.

[Browser access](browser-access.md) owns public-site eligibility, requested-only authentication capture, fixed snapshots, typed tools, actual-stop receipts, and uncertainty. [Browser operation](../runbooks/local-development.md#operate-browser-tasks) owns private setup and rollout; [integration evidence](../learning/assistant-core-verification.md#browser-integration-verification) separates isolated checks, live execution, and site-portability limits.

### Protected HTTP surface

Exact `GET` and `HEAD` requests to `/`, `/privacy`, and `/terms` serve public static app information. They contain no owner identity, sign-in, assistant data, scripts, or remote assets. Unknown paths and other methods do not gain public access. `GET /health` returns only liveness. Generic Agents RPC and WebSocket routes are not exposed. Except for the Telegram webhook and the exact one-use-code `POST /api/device/pair` route, protected routes use `Authorization: Bearer …`. Control and executor secrets must be distinct and at least 32 characters long. Device credentials authorize only the explicitly enumerated [companion routes](phone-companion.md#pairing-tools-and-http-contract), never a generic path prefix or model authentication.

| Method and path | Role | Contract |
| --- | --- | --- |
| `GET /api/status` | Control | Model configuration, non-secret credential metadata, recent operations, jobs, reminders, choices, deliveries, executors |
| `POST /api/messages` | Control | `{id, text}`; durable admission, HTTP 202 |
| `GET /api/messages/:id` | Control | Operation status, result or error, and its answer deliveries |
| `GET /api/jobs` | Control | Recent jobs, including exact command, cwd, timeout, version and outcome |
| `POST /api/jobs/:id/approve` | Control | `{version}` matching the reviewed command; omission is rejected |
| `POST /api/jobs/:id/cancel` | Control | Optional `{version}`; running cancellation awaits executor confirmation |
| `GET /api/coding`, `/api/coding/sources`, `/api/coding/tasks` | Control | Coding status, uploaded source metadata, and task records |
| `POST /api/coding/tasks` | Control | `{taskId, prompt, cwd, timeoutMs}`; explicit task request, not approval |
| `POST /api/coding/sources/:id` | Control | Raw bounded gzip; exact Content-Length and `x-umpi-coding-cwd` as base64url UTF-8; export is not execution approval |
| `GET /api/coding/tasks/:id` or `/runs` | Control | Current task or retained per-run history |
| `GET /api/coding/tasks/:id/patch` or `/checkpoint` | Control | Current review artifact |
| `GET /api/coding/tasks/:id/runs/:runId/patch` or `/checkpoint` | Control | Historical run artifact; no auto-application |
| `POST /api/coding/tasks/:id/approve`, `/cancel`, `/correct`, `/cloud`, or `/reconcile` | Control | `expectedVersion`; correction adds `text`, cloud adds `sourceId`, reconciliation requires `confirmStopped: true` |
| Enumerated `/api/browser` control, site, snapshot-metadata, and task routes | Control | [Browser access](browser-access.md#protected-http-surface) owns exact methods and version-bound task decisions |
| `GET /api/browser/sites` | Control or browser-sync | Approved site policy metadata, never cookie values |
| `GET /api/browser/snapshot-key`, `/snapshot-requests`, or `/snapshot-requests/:id`; `POST /api/browser/snapshots/:id` | Browser-sync only | Public encryption key, owner-approved capture scopes, or bounded encrypted upload; separate `UMPI_BROWSER_SYNC_TOKEN`, no task approval |
| `GET /api/reminders` | Control | Persistent reminder records |
| `GET /api/schedule` | Control | Settings, bounded commitments/wake-ups/run history, and last-check reason |
| `PUT /api/schedule/settings` | Control | `{expectedVersion, enabled, quietHours}`; quiet hours are `null` or `{start, end}` in distinct local `HH:mm` values |
| `GET /api/schedule/commitments` or `/wakeups` | Control | Bounded operational records |
| `POST /api/schedule/commitments` | Control | Create an explicit responsibility in the control conversation; immutable origin and notification permission |
| `PUT /api/schedule/commitments/:id` | Control | Complete editable fields plus `expectedVersion`; use `status: cancelled` to retire it |
| `POST /api/schedule/wakeups` | Control | `{id, commitmentId, purpose, dueAt, expiresAt, repeatEveryMinutes}`; recurrence may be `null` |
| `PUT /api/schedule/wakeups/:id` | Control | Complete purpose/time/window/recurrence fields plus `expectedVersion`; linkage stays fixed |
| `POST /api/schedule/wakeups/:id/cancel` | Control | `{expectedVersion}`; invalidate the scheduled/running wake without cancelling its responsibility |
| `GET /api/mail` | Control | Read-only authorization presence, settings, fixed bootstrap boundary, sync status/issues, and state counts; no credential or message body |
| `PUT /api/mail/settings` | Control | `{expectedVersion, enabled, lookbackDays, pollMinutes, bootstrapAfter?}`; enabling requires an established owner Telegram session |
| `POST /api/mail/check` | Control | Optional `{rebootstrap: true}`; queue a check or explicit bounded cursor recovery, never expand past 30 days |
| `GET /api/mail/items` | Control | At most 50 selected attention/snoozed items with summaries, reasons, suggested actions, and Gmail links; no retained message bodies |
| `POST /api/mail/items/:id/handled` | Control | `{expectedVersion}`; clear retained excerpts and mark Umpi operational state handled without changing Gmail |
| `POST /api/mail/items/:id/snooze` | Control | `{expectedVersion, until}` within 30 days; defer Umpi review without changing Gmail |
| `GET /api/planning` | Control | Settings, bounded day status, source availability, and unresolved write metadata |
| `PUT /api/planning/settings` | Control | `{expectedVersion, enabled, time}`; local `HH:mm`, cancels stale active preparations but retains write evidence |
| `GET /api/planning/days/:day` | Control | Saved preparation projection and owner brief, not a live note/calendar |
| `PUT /api/planning/briefs/:day` | Control | `{expectedVersion, text}`; explicit intent for today through the next seven days |
| `POST /api/planning/prepare` | Control | Queue current-day preparation; admission is not upload confirmation |
| `POST /api/planning/days/:day/cancel` | Control | `{expectedVersion}`; stop current authority, retain any dispatched write |
| `GET /api/planning/writes/:id` | Control | Exact retained before/after text and receipt for private review |
| `POST /api/planning/writes/:id/abandon` | Control | `{expectedStatus}` of `prepared` or `unconfirmed`; explicit release, never remote undo |
| `POST /api/auth` | Control | Canonical OAuth credential for a supported provider; metadata-only response |
| `GET /api/core-context` | Control | Private selected context, source mappings/hashes, current revision, and pending-source flags |
| `PUT /api/core-context` | Control | `{expectedRevision, blocks}`; atomic synchronized replacement, stale revision HTTP 409, invalid provenance HTTP 400 |
| `GET /api/core-context/reviews` | Control | Pending owner reviews; not committed memory |
| `GET /api/core-context/reviews/:id` | Control | Exact proposal, before/after text, and decision status |
| `POST /api/core-context/reviews/:id/approve` or `/reject` | Control | Decide the immutable stored review; no replacement fields; stale approval returns HTTP 409 |
| `GET /api/core-context/history` | Control | Newest-first revision snapshots; optional exclusive `beforeRevision` and bounded `limit` |
| `GET /api/core-context/history/:revision` | Control | One retained historical snapshot |
| `POST /api/core-context/restore` | Control | `{id, expectedRevision, blockId, revision}`; creates a review, never immediately applies it |
| `GET /api/subagents` | Control | Bounded child metadata, including requested stop and pending reports |
| `GET /api/subagents/:id` | Control | Child scope, durable latest report, and actual native-idle inspection |
| `POST /api/subagents/:id/cancel` | Control | `{expectedVersion}`; stop the exact child generation, not a later follow-up |
| `GET /api/executor/wake?executorId=ID` (WebSocket upgrade) | Executor | The only accepted upgrade. The coordinator sends `wake` when new Mac work appears; the runtime answers `ping`, and the coordinator answers `hello` with `ready`. See [wake socket](mac-executor.md#wake-socket-and-polling) |
| `POST /api/executor/poll` | Executor | Executor identity and canonical workspace list; assignment and cancellation requests |
| `POST /api/executor/complete` | Executor | Immutable completion from the assigned executor |
| `POST /api/executor/coding/poll` or `/report` | Executor | Separate coding assignment/report protocol; never owner approval or source administration |
| `POST /api/executor/browser/poll` or `/report` | Executor | Independent browser lane; actual original-closure evidence and retained uncertainty, no credential-export or owner administration |

`model.configured` means the configured provider has usable credential state, not that its network request has succeeded. Status reads do not clear a known model failure. Model/provider environment values select new Pi conversations. Coordinator startup also reapplies that model to existing control, Telegram, and proactive conversations so a deployment changes the main assistant without discarding its transcripts. Existing task-specific coding or browser conversations are not changed mid-run. There is no model-switch route in this surface.

Request bodies and action inputs are bounded. Public errors do not expose raw provider failures or credentials. Model authentication and refresh ownership are specified in [model authentication](model-auth.md).

Coding owner and executor routes are role-disjoint. No public container proxy is exposed. Telegram coding approvals bind the exact version and confirmed native message; forged, stale, or unconfirmed buttons cannot mutate a task.

Commitment creation accepts `id`, `purpose`, `source`, `nextAction`, `blocker`, `status`, `nextReviewAt`, `jobId`, `allowNotify`, and optional `retry` (`null` or `{ everyMinutes, maxAttempts }`; an update that omits it keeps the current policy). `blocker`, `nextReviewAt`, and `jobId` may be `null`; status is `active`, `blocked`, `completed`, or `cancelled`. Updates supply the same editable fields except `id` and `allowNotify`, plus `expectedVersion`. Text and timestamps are bounded and validated; unknown fields fail. Stored source descriptions are context, not authorization tokens.

Companion tools read saved app state, apply targeted revision-safe changes, and request acknowledged device effects. Optional APNs configuration and delivery semantics belong to the [phone-companion contract](phone-companion.md#push-transport); missing push configuration does not disable foreground synchronization.

### Verification and operation

The [development and operation runbook](../runbooks/local-development.md) owns local setup, hosted deployment, execution, and recovery commands. [Core verification](../learning/assistant-core-verification.md) records actual runtime evidence and its limits.

## History

- 2026-10-11: Implemented the persistent coordinator, authenticated text interfaces, reminders, version-bound Mac approvals, readable Telegram controls, and uncertain-send handling.
- 2026-10-11: Added selected core context, automatic prompt inclusion, revision-bound correction, owner-reviewed memory proposals/history, and explicit-section vault synchronization.
- 2026-10-11: Added scoped phone pairing, native workflow tools, effect acknowledgements, optional APNs delivery, and initially paused proactive scheduling.
- 2026-10-11: Added current-day preparation, read-only Calendar inputs, direct journal merges, recoverable writes, and a separate on-demand Headless Sync adapter.
- 2026-10-13: Added native private-copy coding, separately approved source-only cloud coding, native background subagents, and bounded Telegram voice-note input.
- 2026-10-14: Removed private rollout chronology while preserving reusable contracts and evidence boundaries.
- 2026-10-15: Added bounded read-only Gmail history checks, durable lossless page continuation, multi-batch one-digest triage, version-bound owner actions, and separate OAuth.
- 2026-10-15: Added channel-specific rendering of conversational Markdown as Telegram-native entities while preserving Markdown on other channels.
- 2026-10-19: Added multiple mailboxes, byte-bounded review batches, code-level bulk-tab skipping, cleaned bodies, the situation record with backfill extraction, the morning brief, and medium background effort.
- 2026-10-19: Added calendar heads-ups, due-soon nudges, stalled-commitment reviews, and source-side exclusion of bulk tabs during bootstrap.
- 2026-10-19: Added daily-note close-out, intra-day additions, owner note requests, and task check-ins as code-owned journal writes.
- 2026-10-20: Added per-commitment retry policies after a subscription usage window ran out overnight and the brief and daily note failed once with no retry. The brief and daily note retry hourly, at most three times.
- 2026-10-21: Moved daily-note reads and writes to the owner's obsy vault over an R2 binding, with a compare-and-swap write.
- 2026-10-21: Removed the Obsidian Headless `VaultSync` container, its archive bucket binding, and the workspace provisioning route.
- 2026-10-22: Added the Aside context: activity summaries for chat and the brief, and owner memory search through the Mac.
- 2026-10-22: Added failure causes to run notes and a once-a-day Telegram notice when a retrying commitment gives up.
- 2026-10-22: Added image input (photos, image files and albums). Other attachments are skipped with a short reply instead of a rejected webhook.
- 2026-10-24: Added the executor wake socket, owned by a lifecycle capability, and protected `executor` status (online, last seen). After a day without the executor, one Telegram notice says Mac work is waiting.
