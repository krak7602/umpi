---
title: Phone companion and device acknowledgment
aliases: [iPhone companion, personal Umpi app, SwiftUI, AlarmKit, device alarms]
updated: 2026-10-14
---

# Phone companion and device acknowledgment

## Current

### Implemented companion

`ios/` contains a native SwiftUI app and a WidgetKit Live Activity extension. The app has Workflows, Activity, and Settings tabs, scoped pairing, dynamic native forms and actions, protected command review, durable local drafts/outbox, AlarmKit alarms, and local notifications. The coordinator stores companion records in application tables in its existing Durable Object SQLite database. This code is implemented; deployment, private signing, and physical-device delivery are separate operating steps.

The companion is separate from any external caller or voice system. Calls are not a prerequisite; any later voice work must meet the [voice retention criteria](../concepts/interaction-quality.md#voice-retention-criteria).

The [coordinator's text reminders](assistant-runtime.md#reminders) remain distinct from native phone alarms. Telegram remains the conversational desktop/phone interface. This app provides structured workflows and device actions, not a caller conversion or a duplicate chat transcript.

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
| `POST /api/device/messages` | Device credential; idempotent `{id,text}` admission to the control conversation |
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
