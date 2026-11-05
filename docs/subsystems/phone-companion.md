---
title: Phone companion and device acknowledgment
aliases: [iPhone companion, personal Umpi app, SwiftUI, AlarmKit, device alarms]
updated: 2026-11-03
---

# Phone companion and device acknowledgment

## Current

### Implemented companion

`ios/` contains a native SwiftUI app and a WidgetKit Live Activity extension. The app has Workflows, Activity, and Settings tabs, scoped pairing, dynamic native forms and actions, protected command review, durable local drafts/outbox, AlarmKit alarms, and local notifications. The coordinator stores companion records in application tables in its existing Durable Object SQLite database. This code is implemented; deployment, private signing, and physical-device delivery are separate operating steps.

The companion is separate from any external caller or voice system. Calls are not a prerequisite; any later voice work must meet the [voice retention criteria](../concepts/interaction-quality.md#voice-retention-criteria).

The [coordinator's text reminders](assistant-runtime.md#reminders) remain distinct from native phone alarms. The app and Telegram share one owner conversation; see [shared chat](#shared-chat). Telegram stays a second door for now; the owner may phase it out once the app covers enough.

### Shared chat

The app's chat is the owner's Telegram conversation, not a second one. `POST /api/device/messages` admits `{id, text?, sentAt?, voice?, spoken?, interrupts?, heard?, images?, file?, context?, media?}` to the Telegram Pi session with an `app-text`, `app-image`, or `app-file` source, so Umpi remembers both surfaces as one conversation. Up to four images (1 MB together, as for Telegram) or one file (10 MB, read as in [Telegram files](assistant-runtime.md#images-and-other-attachments)) can be sent; the body may be 15 MB. The reply to an app message stays in the app: it is not sent to Telegram.

`chat.ts` keeps the readable history in the coordinator's SQLite, written in the same transactions that admit owner messages and queue Umpi's Telegram messages: what the owner said on either surface, Umpi's replies, and the messages Umpi started (brief, reminders, mail, approvals and questions, with their buttons). Telegram command panels (`/mail`, `/schedule`, memory views, and other menus) are Telegram's own interface and are left out. `GET /api/device/chat` pages it by position: `?limit=` (default 50, at most 100) returns the newest, `?before=N` older entries, and `?after=N` newer ones; `latest` is the newest position. Images are counted, not stored; a file is named.

The app's first tab, **Chat** (`ChatView.swift`, `ChatModel.swift`), shows this history, loads earlier pages on request, shows messages still in the durable outbox as sending, and shows "Umpi is thinking…" until the reply to the latest app message arrives. It keeps its newest 100 entries in the app's caches and shows them at launch; the first read then takes the newest page whole (so buttons are current) and later reads fetch only what is new. Disconnecting removes these copies, the Today copies, and attachment previews. It sends through the same outbox as other device requests; the circle button left of the field attaches when it is empty and, while typing, also offers Markdown formatting (bold, list, checklist, code block), so no toolbar floats over the keyboard. The owner's messages are tinted bubbles; Umpi's replies read like a note, full width; messages Umpi started (reminders, questions, approvals, alerts) are cards. Messages said in Telegram are marked "Telegram".

`MarkdownView.swift` renders Markdown with Apple's swift-markdown parser: headings, lists, checklists (Apple Notes circles), tables (hairline borders, wide tables scroll), quotes, code blocks with copy, rules, and Obsidian's callouts (`> [!tip] Title`), highlights (`==text==`), and wiki links (`[[Note|alias]]`). Code blocks are colored by [highlight.js](https://highlightjs.org) (BSD-3-Clause, bundled in `ios/Umpi/Resources/Highlight` with its license) in JavaScriptCore, as native text in an Xcode-like palette; a block without a language is detected when it has a few lines. A `mermaid` code block is drawn by [Pele](https://github.com/obsidianmd/pele) (MIT, bundled in `ios/Umpi/Resources/Pele` with its license) in a small offline web view with the system's colors; a diagram Pele cannot draw shows its source.

The message field is a UIKit text view (`ComposerTextView.swift`), so photos, a video, or a file pasted from another app (the edit menu or the keyboard's paste suggestion) become an attachment, as if picked; text pastes as text. The composer attaches, through the same outbox (`ChatAttachments.swift`; attachment data waits in its own protected file, excluded from backup, and is deleted once sent):

- **Photos:** up to four, scaled and compressed to fit 1 MB together.
- **Files:** text, Markdown, CSV, JSON, PDF, and Word up to 10 MB, read on the coordinator like Telegram files.
- **Talking:** with nothing typed, the waveform button in the field opens [voice mode](#voice-mode). The app no longer records voice notes; a voice message from voice mode shows as a voice note.
- **Audio files:** transcribed on the phone and sent as text with the file name.
- **Video:** Claude cannot watch video, so four frames from across it (exact times, not the nearest keyframe) go as images, with its speech transcribed.

The owner's own words are the message; text meant only for Umpi (a video's frames note and transcript, an audio transcript) goes as `context`, which reaches the model after the owner's words but is not shown in the history. `media` (`kind` photos, video, audio, file, or voice, with `name`, `seconds`, `count`) tells every surface what was attached. The sending phone keeps small previews (`LocalMedia`: thumbnails, length, size) keyed by the message's operation, so its history shows photos as thumbnails, a video as its first frame with a play badge and length, a file as a card, and an audio file as its name and length. A voice note shows as its transcript with a "voice note" tag; its recording is not kept, so there is nothing to play. Other surfaces show a compact label; the coordinator stores no media.

Speech uses the phone's on-device recognizer when it has one, and Apple's recognition service otherwise. The simulator has neither, so voice notes and video speech must be checked on a real phone; a failed transcription says why in the composer.

### Voice mode

Voice mode is a spoken conversation with the same Umpi: the phone hears and transcribes the owner, Claude answers in the shared conversation, and the phone reads the reply aloud as it is written. Nothing but text leaves the phone, and no voice model or extra service is involved.

- **The message.** A spoken turn is a voice message with `spoken: true`. Umpi's model input then says the reply is heard aloud: short spoken sentences, no Markdown or lists, and one sentence that says what it is doing before tools or longer work, never a filler. Things said in passing are filed as the old Voice button's notes were: an idea in today's note, a task under tasks, anything with a time as a reminder. Its [effort](assistant-runtime.md#decision-models) is chosen with a 0.7-second limit, and an unsure or late answer keeps `low`.
- **The reply as it is written.** `speech-relay.ts` follows the conversation's agent events from just before the turn is submitted and passes on only the run that answers it: `{"type":"speech","operationId","part","text"}` for new text, `{…,"working":"<tool>"}` when a tool starts, and `{…,"done":true}` at the end. Thinking is never sent. `part` counts the answer's model messages, so a sentence written before a tool call and the answer after it stay separate. Partials are saved about every 100 ms, so text is also taken from each finished message. Frames go to every open app; each app speaks only replies to its own messages. If the relay cannot watch, or the Durable Object restarts mid-turn, the finished reply still arrives as a chat entry, and the app reads that aloud instead.
- **Cutting in.** The owner talking over a reply sends the next spoken message with `interrupts` (the reply's operation) and `heard` (what the phone had read aloud). A reply not yet sent to the model ends at once; a running one is stopped. Its chat entry keeps only what was heard, marked "(cut off when you started talking)", and the stop is not recorded as a model failure. A reply already written in full is left alone, since the phone reads more slowly than Claude writes. Either way the new message tells Umpi how much was heard, so it does not assume the owner heard the rest.
- **The app.** The waveform button in the chat's message field, the widget's Talk button, the "Talk to Umpi" control (Control Center or the Action Button), or `umpi://talk` opens `VoiceModeView`. `VoiceAudio` runs the microphone with the phone's echo cancellation, finds when the owner starts and stops talking by loudness against a running noise floor (with 0.4 s of audio kept from before, so the first syllable is not lost), and transcribes with the phone's recognizer as they talk, on the phone when it can. A pause of 0.7 s (adjustable) ends the turn; the recognizer's final words are awaited for up to 0.9 s. `VoiceSpeaker` writes each sentence with `AVSpeechSynthesizer` and plays it through the same audio engine, so the echo canceller knows Umpi's voice. While Umpi speaks, a louder sound is checked for words at full volume; two words or more stop the reply, otherwise Umpi carries on. After the first sentence, waiting sentences are spoken as one stretch, so there are fewer seams. Echo cancellation can briefly turn speech down when it thinks someone is talking over it, so with cutting in off, Umpi's voice plays without it. Opening voice settings pauses voice mode, and samples play as plain spoken audio. The orb breathes while listening, follows the owner's voice, dims slightly and flows (its layers drift against each other) while Umpi thinks or a tool runs, with the caption naming the tool (such as "Checking your calendar"), and follows Umpi's voice while it speaks. There is no spinner; every change of state eases in. Voice mode listens only while it is on screen and keeps the screen awake. Settings › Voice mode chooses any installed voice (Enhanced and Premium voices, and a Personal Voice with permission; Siri's voices are not available to apps), its speed and pitch, the pause, and cutting in. The simulator has no speech recognition; Debug builds send a fixed question on a long press of the orb to check the reply path there.

### Today and Work

The app's tabs are **Chat**, **Today**, **Work**, and **Settings**. **Today** (`TodayView.swift`) shows the day's note from the owner's obsy vault, the note [daily preparation](assistant-runtime.md#daily-note-preparation) writes, rendered like the chat with its frontmatter hidden; arrows move between days. `GET /api/device/today?day=` returns `{day, text, revision}` (today in the owner's timezone by default; `text` is null without a note). Tapping a checkbox calls `POST /api/device/today/task {day, line, text, checked}`: `ObsyVaultClient.setTask` changes only that line, and only while it still reads as the app showed it, through a compare-and-swap commit by agent `umpi`. Edits elsewhere in the note are kept; a changed line returns `conflict` with the latest note, which the app then shows. Without a configured vault the routes answer 503 and Today says notes aren't available. The coordinator keeps one obsy reader for its lifetime, so a read catches up only on commits since the last one instead of rebuilding the vault from its checkpoint and log each time. The app keeps the last copy of each day's note in its caches and shows it at once, then refreshes it.

**Work** (`WorkView.swift`) lists what needs the owner first: [T3 Code](assistant-runtime.md#t3-code-threads) actions Umpi asks to approve, coding threads waiting on an answer, device actions to review, commands awaiting approval, and open questions. Then **Running** (active coding threads and Mac commands, and machines that did not answer), **Recent** (finished threads not yet settled, five at most), the next reminders, and links to Workflows and the full activity record. With more than one machine, chips at the top narrow the coding rows to one. The tab's badge counts what needs the owner. Colour only shows status: blue working, orange waiting, green done, red failed. A coding thread opens to its status, latest messages, and any question its agent asks, with the choices as rows a tap answers (multiple choice and an own answer when the agent allows). A reply field messages the agent, and Stop works while it runs; deeper work belongs in T3 Code. An approval is a card that shows the action, the words to send on a light fill, and Umpi's reason, with Decline and Approve; the same card appears in the chat and in Work and changes in place to done, declined, failed, or expired. The approval's outcome note, sent for Telegram, is hidden in the app. When Umpi's messages alert in the app, an approval's notification offers Approve, which needs Face ID or the passcode, and Decline. Work reads threads each time it appears and keeps the last overview in the app's caches; approvals are read again whenever the app returns to the foreground. Cloud machines carry a ☁︎ mark; a sleeping one's thread shows its saved state with a Wake button instead of waking it to read. Settings lists T3 Code machines with their approval state (cloud machines show awake or asleep, and swipe deletes one with its saved state), adds a machine from its MCP address, and opens the approval page again when access ends.

### Widgets and quick capture

The widget is a launcher. Its buttons are stored state (`WidgetStore.actions`): 1 to 4 of `voice` (labelled Talk: opens voice mode), `today`, `chat`, `work`, and `remind` (the chat, ready to finish "Remind me …"), by default voice, today, chat, work. The owner picks them in Settings › Widget (`PUT /api/device/widget/actions`), and Umpi can change them with `set_widget_actions`; a change wakes the phone like other owner state. Stored buttons from before are read in these terms ("idea" becomes voice). The small widget and the circular lock-screen widget show the first button; the medium widget all of them as icons with names; the large widget what's next at the top and the buttons along the bottom as icons only. A second small widget, **Umpi Buttons**, fits all four in a 2×2 grid.

Widget buttons and the `UmpiCapture` control ("Talk to Umpi", for Control Center or the Action Button) run `OpenUmpiAction` (`ios/Shared/OpenUmpiAction.swift`, in both targets): the system opens the app and runs the intent there, and `UmpiRoute` keeps the request until the app's screens are ready, so a cold launch keeps it. The chat takes its part from `ChatRequests` when it appears. The Talk button and the control open [voice mode](#voice-mode), which waits until the app is in front before using the microphone, since iOS refuses it while the app is still opening. `umpi://<action>` links open the same routes.

What's next is the other half of the content: Umpi can choose 1 to 8 items with `set_widget` (title, optional detail, SF Symbol, and a link) for up to 48 hours, or return to the default with `clear_widget`. The default is what is waiting on the owner, the open tasks of today's note (Markdown marks removed), and the next two reminders. `GET /api/device/widget` returns `{items, source, updatedAt, note?, actions}`. After each sync the app copies it into its App Group (`group.` plus the app identifier, in both targets' entitlements) and reloads the widgets when it changed.

The simulator verified the content path; the widget's look at each size and the control need checking on the phone.

**Settings** groups Alerts (notifications, reminder knocks, where Umpi's messages alert through the chat `notify` setting, and wake-up alarms), Permissions (letting Umpi act on the phone), Server, and Disconnect, in plain words; technical details sit under a Details disclosure.

### Knocks

Reminders knock on the phone in place of alarms (`Knocks.swift`). After each refresh the app sets every scheduled reminder (up to 18 ahead) as local notifications on the phone itself, so a knock comes even offline: a Time Sensitive notification with Umpi's own knock sound, then two repeats three minutes apart. The sounds are synthesized for Umpi, so no licensed tone is bundled, and last 30 seconds, the iOS limit for a notification sound (a longer file is replaced by the default). `knock.caf` rises in three stages: a soft, slow wooden double knock, then louder, then full volume knocking twice as fast with a brighter tone (peaks about −8, −2, and 0 dB). Repeats use `knock-loud.caf`, which starts at the second stage. A `gentle` reminder knocks once with a short sound at the normal level. **Done**, **Snooze 10 min**, and **Later** answer it through the durable outbox (`POST /api/device/reminders/:id/answer {version, action}`); opening or dismissing it stops the repeats and leaves the reminder open. A knock answered a few seconds before the coordinator fires the reminder fires it once, without a second message. "Wake me" stays a native alarm.

iOS wakes a closed app only now and then, so a new reminder can reach the phone after it is due. Then the server knocks instead (`KnockPushStore`, `knock-push.ts`): when a reminder fires that no phone confirmed, and a phone can take alerts, it pushes the same knock (category `UMPI_KNOCK`, the knock sound, Time Sensitive, thread `knock.<id>`, with the reminder's ID and version), repeated three and six minutes later until the reminder is answered, changed, or cancelled; a gentle reminder is pushed once. The phone never adds a knock for a reminder already due, so the two do not overlap, and answering clears pushed knocks as well as local ones. Protected `GET /api/status` → `knocks.pushed` counts them.

The app reports the reminders it has set (`POST /api/device/knocks {scheduled: [{id, version}]}`) only while notifications are allowed. A reminder a phone confirmed is then delivered to Telegram silently and not pushed again; without that confirmation Telegram stays the alert. Time Sensitive delivery needs the `com.apple.developer.usernotifications.time-sensitive` entitlement and the owner's Focus settings. The simulator shows the knock on time as Time Sensitive; its notification buttons and the sound on a locked phone need checking on a real phone.

Buttons on Umpi's messages work in the app. `POST /api/device/chat/press {seq, data}` runs the same handler as a Telegram press. When the message reached Telegram, the press is bound to that Telegram message and its Telegram keyboard changes too; otherwise approvals and questions are bound to their own message, and other buttons say to answer in Telegram. A question answered in the app is replied to in the app.

The app keeps a socket at `GET /api/device/chat/socket` (WebSocket, device credential). It carries `{"type":"chat","latest":N}` when the conversation grows; the app then reads the new entries. While a spoken reply is written it also carries that reply's [speech frames](#voice-mode). A revoked device's socket is closed.

`GET` and `PUT /api/device/chat/settings` hold `notify`: `telegram` (default) or `app`. With `app`, each message Umpi starts is announced on every paired phone with an APNs alert (title "Umpi", a preview of up to 600 characters, `chat` position, thread `chat`) and Telegram delivers the same message silently. While Umpi is open, a chat alert is not shown when the chat is on screen and is shown quietly on other tabs; knocks always show. Replies follow the surface: an app reply is announced in the app; a reply in Telegram stays a normal Telegram message and is not pushed. A failed alert is tried up to three times; an uncertain one is not repeated. APNs acceptance is not delivery, so switch to `app` only after alerts are seen arriving on the phone. Protected `GET /api/status` → `chat` reports the setting, entries, push outcomes, and open sockets.

### Roles and composition boundary

| Role | Responsibility |
| --- | --- |
| Owner | Enters and edits data, grants device permissions, and approves protected actions. |
| Umpi agent | Reads current app snapshots, authors bounded definitions, and requests explicit typed changes through advertised capabilities. |
| Native app | Renders supported components, protects local input, checks revisions and permissions, performs supported device effects, and acknowledges their actual results. |
| Cloud coordinator | Owns durable workflow state and asynchronous reasoning/jobs; records requests and results without claiming unacknowledged device effects. |

The app has a stable native shell and a shipped component/capability runtime. Umpi can compose workflows and screens through bounded, versioned definitions, not downloaded executable code or arbitrary generated SwiftUI. Definitions reference supported component and capability versions. Unsupported definitions must not replace working views or discard their data.

The version-1 vocabulary supports text, multiline, toggle, number, date, and choice fields. Buttons execute sequential `set_value`, `device_action`, and `message` steps, with constant/field bindings and optional equality conditions. Limits are 32 retained workflows, 32 fields per definition, 16 buttons, and 16 steps per button. `src/shared/companion.ts` owns the wire validation; `ios/Umpi/Models.swift` and the native runtime enforce the corresponding client contract.

Permission prompts, pairing, approval presentation, and destructive-action confirmation belong to trusted native UI. Agent-authored content cannot grant permissions, impersonate approval controls, or bypass policy. Show the actual target and effect being approved.

Keep three layers separate:

- **Workflow and screen definitions:** layout, field bindings, and supported interaction rules.
- **Durable domain state:** entities, field values, workflow progress, action records, and revisions. It survives layout changes.
- **Local form drafts:** unsent or in-progress owner input, keyed by stable entity and field IDs. A refresh or agent edit must not erase it.

Use stable entity and field IDs across views and definition versions. A layout migration must preserve data and drafts; removing a field from a view does not delete its value. A migration that cannot preserve a binding needs an explicit resolution, not a silent reset.

### Revision-safe reads and changes

Umpi reads the current coordinator snapshot before changing it. Snapshots expose saved definitions/values, revisions, device capabilities and last-seen time, jobs, questions, requests, and device outcomes. Unsaved drafts stay on the phone; they are not uploaded or visible to the model. The app tracks their baseline revisions and preserves them over newer snapshots. A cloud snapshot or last-seen time is not proof of the phone's current unsaved input or connectivity.

Changes are typed, explicit operations against identified targets, with expected revisions and idempotent action IDs. Definition updates and domain mutations remain distinct. The operation contract must enforce these rules:

- Missing fields in an update mean **unchanged**, never delete or clear. Preserve owner-entered values, local drafts, and unrelated items.
- Create, set/clear a field, remove, and archive are distinct effects. Destructive effects need an explicit request and policy authorization. Do not infer cleanup from an omitted item, a new layout, or an agent's guess.
- Validate expected revisions at application time, including after offline delivery. Never apply a stale whole-screen replacement over newer data.
- On a conflict, preserve both edits and the local draft. Return the current revision and conflict details; reread and merge before retrying. Ask the owner when intent cannot be reconciled safely, rather than silently choosing a winner.
- Replaying an action ID must not apply its effect twice. Reuse of an ID for a different operation is not a valid retry.

A durable offline queue retains pending owner edits, requested operations, and results across disconnects and app restarts. Reconnection reconciles revisions and action IDs before advancing work. Cloud workflow mutations report their committed revisions; native effects instead have action IDs and immutable device outcomes. Cloud admission is not proof of an OS effect. Lost acknowledgements must remain recoverable without repeating that effect.

Historical mutation receipts are not fresh snapshots. After a replay, the app rereads authoritative state before accepting a save or advancing a workflow; an old receipt cannot resurrect a removed workflow or overwrite newer input. Removed-field and removed-workflow drafts remain available for explicit review/discard. Interrupted local button runs retain their step identities and stop at conflicts rather than replaying later effects.

### Local interactions and durable workflows

Known deterministic interactions run locally: navigation, typing, draft preservation, supported validation, and other shipped rules must not wait for a model round trip. Reasoning and long-running cloud jobs are asynchronous, with durable action identity and visible pending/result states. Offline UI must say which actions can complete locally and which are queued or unavailable.

Cloud durable workflow records are authoritative for cloud jobs and their progress. Notifications and Live Activities surface changes and link to the corresponding durable action; their payloads are not the workflow database. The app reconciles with authoritative state when it can connect and keeps unsynchronized local edits distinct. Neither surface gives Umpi always-on background access to the phone. Delayed, missing, expired, or stale Live Activity and notification updates must not turn pending work into success or overwrite newer state.

Foreground synchronization runs every 12 seconds while the scene is active, plus explicit refresh and activation. It stops in the background. Background refresh and APNs are best-effort wake opportunities, not continuous execution. An ActivityKit job remains tracked independently of whether its push token has arrived; terminal state can still reconcile after it leaves the recent-job list.

### Choose the right delivery mechanism

- Use app-owned system alarms for authorized scheduled reminders.
- Use ordinary messages or notifications for routine results.
- Use structured approvals for decisions.
- Use Live Activities for suitable ongoing tasks, not permanent execution or guaranteed fresh state.
- Use calls only when conversation is useful and separately authorized.

Do not turn every calendar event into an alarm automatically. Alarm dismissal is not task completion.

The app's minimum target is iOS 18. [AlarmKit scheduling](https://developer.apple.com/documentation/alarmkit/scheduling-an-alarm-with-alarmkit) is runtime-gated to iOS 26 or later and explicit authorization. Older systems report alarms as unsupported; they do not silently substitute an ordinary notification.

#### Deferred alarm-versus-call policy

Native alarm support is already implemented and has [physical-device evidence](../learning/assistant-core-verification.md#native-companion-verification). Explicit alarm requests remain available; this deferral does not disable that capability.

Detailed alarm-versus-call selection remains deferred until a calling path is implemented and evaluated against the [voice retention criteria](../concepts/interaction-quality.md#voice-retention-criteria). At that point, decide which situations need an alarm, a call, or an ordinary message/notification, and which actions may run automatically under standing owner permission.

Until that decision, do not add automatic planning-to-alarm behavior or grant heartbeat reviews device-effect authority. The proposed automatic wake-up-alarm rule is not an accepted policy. Current [daily-planning and background permissions](assistant-runtime.md#daily-note-preparation) remain unchanged.

### Device acknowledgment is authoritative

A schedule requested by the cloud is not proof that the phone installed an alarm. Alarm registration must expose:

- Pending sync, until a device result arrives.
- Scheduled, only after device acknowledgment of registration.
- Failed, unsupported, or permission required, when applicable.

Changes and cancellations also need device acknowledgment. Do not report an alarm as changed or cancelled merely because the cloud accepted the request. Track the desired action separately from the last confirmed device state, and reconcile after an interrupted connection or permission change.

Device effects require OS permission and either individual trusted review or the owner's explicit “Allow remote device effects” setting. A durable intent is written before the OS call; its result is retained before acknowledgement. Recovery observes installed effects where possible and otherwise reports uncertainty instead of blindly repeating them. An explicit retry of a definitely unattempted permission/availability failure gets a new action ID. Applied or uncertain effects are not replayed by Resume.

Schedule alarms ahead while the device can perform and acknowledge registration. Background APNs delivery is best effort, not a reliable last-minute scheduling channel. See [Apple's background-update delivery guidance](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app). Do not misuse VoIP pushes for non-call work. These delivery limits also apply to attempts to refresh app state in the background.

### Pairing, tools, and HTTP contract

The owner creates a ten-minute, one-use code through Telegram `/pair` or the control pairing endpoint. The phone generates a random credential and stores the exact pending claim in Keychain before sending it. The coordinator stores credential/code hashes, not plaintext credentials. Exact claim recovery is allowed within the code's lifetime; changed claims cannot reuse it. A rejected pending claim can be explicitly abandoned; unconfirmed remote revocation remains visible. Pairing grants owner-data access and version-bound command approval, not executor or OAuth administration.

The agent tools are `read_companion_state`, `update_companion`, and `request_device_action`. Reads exclude pairing secrets and push tokens. Device effects target a specific paired device and return pending until its acknowledgement.

| Method and path | Authorization and effect |
| --- | --- |
| `POST /api/companion/pairings` | Control credential; optional label, returns ephemeral code/expiry |
| `GET /api/companion/state` | Control credential; owner snapshot |
| `POST /api/companion/changes` | Control credential; revision-bound workflow mutation |
| `POST /api/companion/actions` | Control credential; targeted typed device request |
| `DELETE /api/companion/devices/:id` | Control credential; revoke device |
| `POST /api/device/pair` | One-use code in exact claim; no bearer credential required |
| `GET /api/device/state` | Device credential; owner state and this device's actions |
| `POST /api/device/register` | Device credential; capabilities, optional APNs/activity tokens and tracked job IDs |
| `POST /api/device/changes` | Device credential; revision-bound workflow mutation |
| `POST /api/device/actions` | Device credential; register its own typed action |
| `POST /api/device/actions/:id/ack` | Target device only; immutable outcome |
| `POST /api/device/jobs/:id/approve` or `/cancel` | Device credential; exact reviewed `{version}` |
| `POST /api/device/choices/:id/answer` | Device credential; predefined or ordinary non-slash text answer |
| `POST /api/device/messages` | Device credential; idempotent app message admitted to the owner's shared conversation; see [shared chat](#shared-chat) |
| `GET /api/device/chat` | Device credential; shared conversation history by position |
| `GET /api/device/chat/socket` | Device credential; WebSocket that announces new positions and carries spoken replies as they are written |
| `GET`, `PUT /api/device/chat/settings` | Device credential; `{expectedVersion, notify}` |
| `POST /api/device/chat/press` | Device credential; `{seq, data}` presses a button on a chat message |
| `GET /api/device/today` | Device credential; the day's note, `?day=YYYY-MM-DD` optional |
| `POST /api/device/today/task` | Device credential; `{day, line, text, checked}` ticks one checklist line |
| `GET /api/device/widget` | Device credential; what the widgets show and their buttons |
| `PUT /api/device/widget/actions` | Device credential; `{actions}` the widget's buttons |
| `POST /api/device/knocks` | Device credential; `{scheduled}` reminders this phone has set as knocks |
| `POST /api/device/reminders/:id/answer` | Device credential; `{version, action}` with done, snooze, or later |
| `GET /api/device/t3` | Device credential; T3 Code machines and approval state, no tokens |
| `GET /api/device/t3/threads` | Device credential; each connected machine's recent threads, or its problem |
| `GET /api/device/t3/thread` | Device credential; `?machine=&id=` a thread's latest messages, `&after=` to page |
| `POST /api/device/t3/machines` | Device credential; `{url, label?}` adds a machine and returns `{machine, authorizeUrl}` |
| `POST /api/device/t3/machines/:id/connect` | Device credential; starts approval again, returns `{machine, authorizeUrl}` |
| `DELETE /api/device/t3/machines/:id` | Device credential; removes the machine and its access |
| `POST /api/device/t3/act` | Device credential; `{machine, requestId, kind, threadId, message?, question?, answers?}` sends to, stops, or answers a thread; Umpi follows that thread, and when the Mac does not answer it returns `{result: {held: true}}` and sends the action when the Mac is back |
| `GET /api/device/t3/requests` | Device credential; the latest actions Umpi asked to approve, with their state |
| `POST /api/device/t3/requests/:id/approve` or `/decline` | Device credential; answers a request as its message's button does |
| `GET /api/device/t3/questions` | Device credential; `?machine=&id=` the questions a thread's agent waits on |
| `POST /api/device/cloud/:id/wake` or `/sleep` | Device credential; wakes a [cloud machine](assistant-runtime.md#cloud-machines) from its saved state, or saves and stops it |
| `DELETE /api/device/cloud/:id` | Device credential; deletes a cloud machine and its saved state |
| `DELETE /api/device/session` | Device credential; revoke itself |

Mutations use `operationId`, `workflowId`, `expectedRevision`, and explicit `create`, `define`, `set_values`, `archive`, `restore`, or `remove`. Missing values remain unchanged; `null` explicitly clears a value. Stale revisions return 409. Replay identities bind the actor and exact request. Pending device actions are retained independently of the recent completed-action window.

### Push transport

Optional `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, and `APNS_BUNDLE_ID` configure direct APNs delivery. These are private installation values, never checked-in app settings. The Worker signs short-lived ES256 provider tokens and uses hosted `fetch` to Apple's fixed sandbox/production endpoints, without redirects or automatic retries. Background wakeups, alerts, and Live Activity update/end payloads are supported. Push acceptance, failure, uncertainty, and missing configuration are recorded separately from device results.

Live Activity tokens and tracked job IDs are registered privately; completed tracked jobs remain resolvable beyond the recent-job window. APNs acceptance is not phone delivery or alarm registration. Local workerd could not reach APNs in the verification environment; an isolated hosted probe reached both endpoints. Signed delivery still requires separate device evidence. See the [verification record](../learning/assistant-core-verification.md#native-companion-verification).

### Integration extension contract

Future integrations use supported compiled adapters, including [App Intents](https://developer.apple.com/documentation/appintents) where appropriate. App Intents and Shortcuts expose supported actions; they do not grant arbitrary access to other apps. Native platform permissions and each integration's supported interface still apply.

The runtime's extension boundary is a capability descriptor and a dispatch/result contract:

| Contract | Required information |
| --- | --- |
| Identity and support | Stable capability ID, contract version, supported device/platform versions, and installed adapter availability. |
| Types | Versioned input and output schemas, including target identifiers and relevant revision preconditions. |
| Authority | Read versus effect classification, permission requirements, and approval/policy requirements. |
| Dispatch | Typed request, action ID, selected device/adapter, expected revisions, and explicit accepted/pending versus applied outcomes. |
| Result | Correlated action ID, typed result or failure/conflict/permission/unsupported outcome, resulting revisions where relevant, and device acknowledgment for device effects. |

The app advertises only implemented capabilities, with explicit availability and permission status for that device. Availability can change after discovery; dispatch must recheck support and permission. An unsupported or unpermitted action stays unavailable, with a truthful reason. Do not install fake adapters, claim a future integration works, or route an unsupported request through arbitrary app control.

Task status, pending decisions, native device-action outcomes, and task Live Activities are implemented surfaces. Share-sheet capture, App Intents/Shortcuts, ordinary home-screen widgets, and other-app adapters remain candidates, not advertised capabilities. Core memory and executor behavior remain specified in their existing subsystem pages.

### Personal distribution and public-source safety

Personal distribution is supported; an App Store release is not assumed. Personal use does not waive Apple signing, entitlements, authorization prompts, or background-execution rules. See [native development](../runbooks/local-development.md#native-app-development) for local signing and pairing without treating personal distribution as a permission bypass.

Checked-in project settings are generic. Private deployment/signing values belong in ignored `*.local.xcconfig` files or appropriate private credential storage. Do not commit Apple team, key, App Store Connect, or private app/bundle identifiers, signing material (`.p8`, `.p12`, `.mobileprovision`), APNs device tokens, or owner/device-identifying configuration. The phone uses scoped, revocable device pairing credentials, never coordinator control credentials or model-provider credentials. Its protected cache and effect ledger exclude credentials and backups. Disconnect explicitly clears local session/data and attempts remote revocation; it does not cancel already scheduled OS effects.

### Physical-device verification boundary

Simulator rendering and coordinator acceptance do not establish real alarm ringing or push delivery. The [verification record](../learning/assistant-core-verification.md#native-companion-verification) distinguishes exercised paths from remaining phone-side checks:

- Supported composition and definition-version handling, trusted approval UI, and permission/capability changes. Unsupported actions remain unavailable; no adapter may claim an effect it did not perform.
- Owner typing while Umpi edits the same entity, unrelated-field updates, explicit clears/removals/archives, and definition/layout migrations. Values and drafts survive; stale revisions conflict, and reread/merge preserves both edits.
- Offline edits, app restart, queued delivery, replay, and lost acknowledgments. Effects occur once, conflicts remain visible, and cloud acceptance stays distinct from device application.
- Alarm authorization denial/revocation, unsupported OS versions, schedule/change/cancel acknowledgment, and delayed or absent background push. Confirm actual device registration, not merely a sent request.
- Local deterministic interactions without a network round trip, and durable asynchronous jobs across reconnects. Stale, missing, or ended Live Activities and delayed notifications cannot override current workflow state.
- Scoped pairing and private signing/configuration boundaries. No control/model credentials or owner-specific deployment values enter public source or ordinary diagnostics.

Real-device signing, APNs delivery, alarm ringing, and lock-screen Live Activity behavior must be recorded on a connected supported phone. Do not label them verified from a simulator or unauthenticated transport probe.

## History

- 2026-10-10: Separated alarms and structured phone actions from a possible future caller. Explicit authorization and device acknowledgment remain required because cloud acceptance and push delivery do not prove alarm registration.
- 2026-10-11: Accepted and implemented a separate SwiftUI Umpi app with bounded composition, revision-safe updates, durable workflows, truthful device effects, and publication safeguards.
- 2026-10-13: Deferred detailed alarm-versus-call selection until a calling path meets the interaction-quality criteria. Explicit alarm support remains available.
- 2026-10-14: Removed external installation history while preserving native capability and verification boundaries.
- 2026-11-03: Added the shared chat backend: app messages join the Telegram conversation, history and a live socket for the app, and app notifications with Telegram silent.
- 2026-11-05: Added voice mode: spoken app messages, replies passed to the app as they are written, and cutting in. Chosen over an on-device speech model (LFM3-Omni ran at half real time on an iPhone 13) and paid voice APIs; Haiku was not faster than Opus at low effort for these replies.
- 2026-11-05: Voice mode replaced the app's voice-note recording: the field's waveform button, the Talk widget button, and the "Talk to Umpi" control open it, and its turns file passing ideas, tasks, and reminders as the Voice button did.
