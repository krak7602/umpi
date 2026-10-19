---
title: Development and operation
aliases: [setup, startup, local assistant, executor recovery, hosted deployment, Gmail follow-through]
updated: 2026-10-19
---

# Development and operation

## Current

### Scope

The local steps run the Worker in workerd, the native Mac executor, and the optional SwiftUI companion. They do not deploy a Worker, register a webhook, install a login item, or change external applications. Use Node 24 or later. A running Docker engine is also required for configured container development and the full build dry run. The verified version set is in the [runtime contract](../subsystems/assistant-runtime.md#pinned-runtime).

For an existing [hosted installation](#hosted-operation), do not repeat initial setup, clone its refresh credential into a local Worker, or repoint its bound Mac journal for development. Use an isolated configuration and state directory for a separate local installation.

### Prepare a new installation

From the repository root:

```sh
npm ci
npm run setup -- local --workspace "$PWD"
```

Run setup once. It creates `.dev.vars` and `~/.config/umpi/mac/config.json`, generates separate control/executor/webhook secrets, and records a stable executor ID. It never overwrites an existing installation. If the second file already exists, it removes only the first file newly created by that invocation. Do not delete existing configuration just to make setup pass.

Repeat `--workspace PATH` to advertise exact individual repository directories. Do not advertise a bulk parent development folder or rely on automatic repository discovery. These are allowed starting directories, not a native filesystem sandbox. The default origin is `http://127.0.0.1:8787`; the default timezone is the Mac's detected IANA timezone. `--server-url`, `--timezone`, and `--provider` select initial settings. Coding opt-in starts disabled; see [Operate coding tasks](#operate-coding-tasks).

`--vars-file PATH` and `--config PATH` support isolated setups. The Mac configuration must be outside this repository. The only permitted repository-local generated secrets file is this checkout's `.dev.vars`, which is ignored by Git. `.dev.vars.example` documents the fields but contains no usable secrets.

### Sign in independently

```sh
npm run auth -- status
npm run auth -- login anthropic
```

Login requires a terminal and browser approval. It stores an independent umpi credential locally; it does not upload it to the coordinator. Choose browser login, open the emitted URL, and approve with the Claude account. The loopback callback completes the login. If a manual callback is necessary, the CLI input is hidden. Never paste a callback or credential into chat. For an alternative OpenAI login, local port 1455 must be available for the browser flow.

A valid coordinator-owned login does not need repeated login or sync on every startup. Read the [refresh ownership rules](../subsystems/model-auth.md#independent-storage-and-explicit-handoff) before moving or replacing an installation. `openai` and `openai-codex` remain alternative logins; `openai-codex` is also the separate voice-transcription grant. None is a substitute label for another provider. To select a provider other than the default, set `UMPI_MODEL_PROVIDER` and `UMPI_MODEL_ID` in private configuration before the handoff.

### Start and provision the local Worker

In one terminal:

```sh
npm run dev
```

The launcher binds to loopback and stores Worker state and logs under `~/.config/umpi/worker`. This directory can contain OAuth credentials and transcripts. It must be owner-only and outside the repository. Preserve it across restarts. Do not replace this command with an unreviewed default-persistence invocation that puts credential-bearing state inside the checkout.

For a new coordinator, run this once in a second terminal:

```sh
npm run auth -- sync http://127.0.0.1:8787 anthropic
```

The auth script loads the control token from `.dev.vars`; token values are not command arguments. Sync replaces the selected coordinator credential. Do not resync an old local copy after the active coordinator has refreshed it.

Then start the executor:

```sh
npm run mac -- run
```

`coordinator_connected` confirms the first successful poll. Leave the daemon running while the Mac should accept approved work. No command runs merely because the daemon started. Use Ctrl-C for an orderly stop. A stopped daemon is not a Mac wake service.

For isolated verification, `dev` accepts `--state-dir PATH`, `--config PATH`, `--port N`, and `--inspector-port N`. Use `setup --vars-file` to place matching secrets beside the selected Wrangler configuration. Keep the executor origin and token matched to that instance. The Mac CLI accepts `--config` and `--state-dir` separately.

### Use the local control API

There is no separate desktop chat UI in this repository. Telegram supplies desktop/phone chat for the deployed installation; the protected control API also supports isolated local operation.

This example creates a real text reminder. It reads the token from the local file without placing it in the process arguments:

```sh
node --env-file=.dev.vars --input-type=module <<'JS'
const id = crypto.randomUUID();
const response = await fetch('http://127.0.0.1:8787/api/messages', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.UMPI_CONTROL_TOKEN}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ id, text: 'Remind me in ten minutes to take a break.' }),
});
console.log({ id, status: response.status, operation: await response.json() });
JS
```

HTTP 202 is admission, not completion. Read `/api/messages/:id` for the settled answer or `/api/status` for current records. Keep the same admission ID only when retrying the exact same text. Use a new ID for a correction and let the model update the existing action.

For a Mac job, inspect `/api/jobs`, including its exact command, cwd, timeout and version. Only then post the reviewed version to `/api/jobs/:id/approve`. A missing or stale version is rejected. Do not write a client that fetches the latest version and approves it without showing the command to the owner. The complete route contract is in [assistant runtime](../subsystems/assistant-runtime.md#protected-http-surface).

Local control deliveries remain in SQLite. They do not ring a phone or send a Telegram message. These are text reminders, not native alarms.

### Operate Telegram voice notes

For an installation with voice-note input configured, send a voice note in its private Telegram chat; Umpi replies in text. No separate bot command, Mac process, or container is required. [The Telegram contract](../subsystems/assistant-runtime.md#telegram) owns limits and recovery, and [model authentication](../subsystems/model-auth.md#voice-note-transcription) owns the separate subscription grant.

For a new installation without a coordinator-owned `openai-codex` login, use an independent Umpi login and explicit handoff. Set `ORIGIN` privately to the intended coordinator:

```sh
npm run auth -- login openai-codex
npm run auth -- sync "$ORIGIN" openai-codex
```

Do not repeat login/sync or replace an active credential merely to enable voice input. Verify protected `GET /api/status` → `telegram.voiceNotes.credentialPresent`, then retire only the local copy just handed off, without printing it:

```sh
node --import tsx --input-type=module -e '
import { FileCredentialStore } from "./src/model/file-store.ts";
await new FileCredentialStore().delete("openai-codex");
'
```

The hosted coordinator owns refresh after handoff; local auth status can therefore be empty. Credential presence alone is not a provider test. Send a short voice note and confirm its real text reply. Protected voice-inbox status retains readable failure/interruption outcomes, not audio or Telegram file IDs. A possibly dispatched transcription is not automatically repeated after restart; send text or a new message rather than replaying an uncertain old update.

### Operate coding tasks

The [authoritative coding contract](../subsystems/assistant-runtime.md#coding-tasks) defines approval, tools, limits, cloud lifetime, and completion. The [Mac contract](../subsystems/mac-executor.md#coding-execution) defines private journals and foreground-group supervision. Bounded native/cloud evidence is in [verification](../learning/assistant-core-verification.md#coding-task-verification). Every installation requires its own explicit resource, deployment, and native opt-in decisions.

First select exact repository paths in private executor configuration. Stop the daemon before opt-in, and preserve its config, executor ID, state directory, and prior run copies. For an isolated installation, pass the same `--config PATH --state-dir PATH` to each command:

```sh
npm run mac -- status
npm run mac -- coding-enable
npm run mac -- run
```

Opt-in grants no task. Submit a foreground task through an owner conversation or `POST /api/coding/tasks` with `{taskId, prompt, cwd, timeoutMs}`. Read `/api/coding/tasks/:id`, review the full prompt, exact source cwd, deadline, and version, then approve with `{expectedVersion}` at `/approve`. Never fetch a new version and silently approve it. After deployment, `/code` provides confirmed-message, version-bound review and task controls. The deployment wrapper publishes the menu; BotFather changes are unnecessary.

Coding and exact-command jobs share one slot. Native source capture includes uncommitted selected bytes but does not edit the original checkout or Git index. Tools execute in the private copy. Review returned artifacts yourself; no command here applies, commits, or pushes a patch. Cancellation is a stop request, not rollback. For crash recovery use [Recover an interrupted Mac](#recover-an-interrupted-mac); confirm all prior processes stopped before resuming. To disable new claims, stop the daemon and run `npm run mac -- coding-disable` with the same private configuration/state options. Retain accepted work and its history.

Cloud source export is separate from execution approval. Set `ROOT` to the exact canonical repository and `PRIVATE` to an existing canonical owner-only directory **outside the repository and selected workspace**. Choose new filenames and stable source/task IDs; existing outputs are refused.

```sh
npm run coding -- snapshot --workspace "$ROOT" --output "$PRIVATE/source.gz"
# Review selected source and exclusions privately before the separate export.
npm run coding -- upload --workspace "$ROOT" --file "$PRIVATE/source.gz" \
  --source-id "$SOURCE_ID" --origin "$ORIGIN"
npm run coding -- download --task "$TASK_ID" --output "$PRIVATE/review.patch" \
  --origin "$ORIGIN"
npm run coding -- download --task "$TASK_ID" --run "$RUN_ID" \
  --output "$PRIVATE/historical.patch" --origin "$ORIGIN"
```

`UMPI_CONTROL_TOKEN` is environment-only; do not put it in arguments, URLs, or chat. Origin is explicit `--origin` or `UMPI_COORDINATOR_URL`; remote origins require HTTPS, loopback HTTP is local-only, and redirects are refused. Snapshot is local-only; upload exports real selected source to the coordinator and does not approve cloud execution. Source filtering is not secret detection: review the actual archive before consent. [Source and RPC bounds](../subsystems/assistant-runtime.md#coding-tasks) fail rather than producing a truncated success.

Read `/api/coding/sources` to verify the stored source ID, cwd, digest, and capture time. Cloud approval posts `{expectedVersion, sourceId}` to `/api/coding/tasks/:id/cloud` only for unclaimed work. An unavailable or uncertain claimed Mac must not be migrated by silence. For a continuation, review the fresh version and bounded run approval; prior private copy/checkpoint must exist. Read `/api/coding/tasks/:id/runs` and use `download --run` for historical patches. Review incremental patches in baseline order, not as independent patches against the original checkout.

Before any hosted coding rollout, obtain explicit owner authorization for new resources and deployment. Keep public and private Wrangler definitions aligned: `CODING_WORKER` → `CodingWorker`, appended `v3-coding-worker`, its separate `containers/coding/Dockerfile` definition with Basic/max one, and `CODING_ARCHIVE` → the intended private R2 bucket. Preserve all existing Assistant/VaultSync migrations, bindings, archives, names, private installation values, and credential state. Provision the authorized private bucket and confirm Containers/R2 access; a paid account alone is not provisioning proof. Do not reuse the vault container or archive for coding.

On first deployment, [Cloudflare can serve Worker routes before container provisioning completes](https://developers.cloudflare.com/containers/guides/deploy/). Inspect application and instance health before treating cloud execution as available. A missing allocation is not proof that code ran. Keep a dispatched run's owner, confirm actual stop, and explicitly reconcile uncertainty before a new approved run. Do not reset state, enlarge allocation, or replay the same run to bypass provisioning failure.

Only after authorized deployment verify the actual live owner routes and menu, then run an explicitly approved bounded generic live-model smoke. Check real source receipt/digest, executed exit-zero check, retained review patch/checkpoint, unchanged original, and actual runner stop. Inspect billed active lifetime, including model thinking. Local Docker/source/CLI evidence is not hosted-model or Telegram visual verification. Do not upload real private source, copy hosted OAuth into a runner/local Worker, overwrite installed Mac config, or enable installed coding merely because build or local checks passed.

### Operate subagents

Native background delegation supports focused foreground assistant work and approved coding. Ask for focused independent work and give concrete goals; the parent decides whether delegation is useful. No new Telegram command, provider login, or Mac opt-in is required beyond a correctly deployed coordinator. [The delegation contract](../subsystems/assistant-runtime.md#subagents) owns capability, deadline, and recovery boundaries; [evidence](../learning/assistant-core-verification.md#subagent-verification) records exercised behavior.

Use `/status` for a compact active/result-ready summary. For exact private inspection, use the existing control credential with `GET /api/subagents`, then `GET /api/subagents/:id`. Copy the returned ID directly into the path; native IDs can contain a colon. Read status, version, pending reports, retained outcome, and `actualIdle` separately. Do not log full reports or context in shared output.

To cancel one child, review its current version, then post `{expectedVersion}` to `/api/subagents/:id/cancel`. This requests a stop; verify actual idle afterward. A stale version cannot stop a later generation. The parent model can use `message_subagent` for a version-bound correction or bounded idle follow-up. For coding work, normally correct or cancel the parent task through its existing controls so all current children receive the lifecycle change.

Coding children share one approved copy, execution slot, and original deadline. Assign separate file ownership and let the parent run the final combined checks. Child completion alone does not finish coding or prove executor stop. Native tools are not a filesystem sandbox; do not treat parallel file work as isolated branches.

For a code rollout, preserve native Pi/application SQLite, provider refresh ownership, original task/run identities, and private executor copies/journals. No binding, migration declaration, credential upload, or new container is needed. Verify the actual live route after deployment; upload/menu metadata alone does not prove Worker/DO cutover. A retained unacknowledged report is reconciled under its same identity, not grounds to spawn replacement work or reset storage.

Additional child calls use the existing subscription and its usage limits. Assistant-only children do not start containers; cloud coding children keep the already approved runner active during model/tool work. Existing Workers/DO/storage and active-container charges still apply.

### Operate browser tasks

The [browser contract](../subsystems/browser-access.md) owns approval, site scope,
model tools, snapshot format, ownership, and stop guarantees. The feature supports
native public-site eligibility and requested-only encrypted refresh after explicit
setup. [Integration evidence](../learning/assistant-core-verification.md#browser-integration-verification)
records actual model/native/provider checks and limits. New installations start
restricted and native-disabled. Live Keychain trust, credential upload, provider
resources, deployment, and installed changes require explicit authorization;
earlier portability or coding authorization does not grant a browser rollout.

#### Grant and enable the native lane

Use a private, isolated Mac config and journal when developing. Set `MAC_CONFIG`
and `MAC_STATE` to that installation's canonical paths outside the repository.
Stop its daemon before changing eligibility or grants. For all-site operation,
read `GET /api/browser/settings`, review its version, then use the owner control
API to PUT `{expectedVersion, allSites: true}` to the same path. Do not silently
approve a newer settings version. Enable the separate native opt-in:

```sh
npm run mac -- browser-enable --all-sites --config "$MAC_CONFIG" --state-dir "$MAC_STATE"
```

For restricted operation, leave coordinator all-site eligibility disabled.
Read `GET /api/browser/sites` and register a reviewed exact policy using
`PUT /api/browser/sites/:siteId` with `{expectedVersion, policy}` (`0` for a new
site). Save the same `BrowserSitePolicy` in a private mode-`0600` JSON file.
Review the policy and canonical digest using the
[site-scope contract](../subsystems/browser-access.md#owner-approved-tasks),
then grant and enable restricted native operation:

```sh
npm run mac -- browser-grant --policy "$SITE_POLICY" --policy-digest "$POLICY_DIGEST" \
  --config "$MAC_CONFIG" --state-dir "$MAC_STATE"
npm run mac -- browser-enable --config "$MAC_CONFIG" --state-dir "$MAC_STATE"
npm run mac -- status --config "$MAC_CONFIG" --state-dir "$MAC_STATE"
npm run mac -- run --config "$MAC_CONFIG" --state-dir "$MAC_STATE"
```

Granting alone never enables browser work. Plain `browser-enable` requires at
least one exact grant; `--all-sites` does not. Request a task in a foreground owner
conversation, or post `{taskId, prompt, sites: [{startUrl}], timeoutMs}` in all-site
mode (`[{siteId, startUrl}]` for registered policies) to `POST /api/browser/tasks`.
Read `/api/browser/tasks/:id`, review the full goal,
sites, corrections, deadline and version, then post `{expectedVersion}` to
`/approve`. Native Telegram `/browse` provides version-bound review and Approve/
Cancel cards after an authorized code/menu rollout. Approval is per task, not a
standing permission to browse. Do not silently fetch and approve a newer version.

Stop the daemon before disabling or revoking:

```sh
npm run mac -- browser-disable --config "$MAC_CONFIG" --state-dir "$MAC_STATE"
npm run mac -- browser-revoke --site "$SITE_ID" \
  --config "$MAC_CONFIG" --state-dir "$MAC_STATE"
```

Revoking the last exact grant disables a restricted lane, not an all-site lane.
To withdraw all-site eligibility, also review and PUT the current settings version
with `allSites: false`; disable native opt-in separately. Neither operation erases
accepted work, uncertainty, or result delivery. Request task cancellation separately
and confirm actual tab closure. For lost connections/popups, use
[interrupted-Mac recovery](#recover-an-interrupted-mac), not guessed tab closing.
Capture revocation and cleanup limits are in the
[snapshot contract](../subsystems/browser-access.md#one-way-snapshots).

#### Build and authorize the separate snapshot helper

Set `PRIVATE` to a canonical owner-only mode-`0700` directory outside the
repository. Keep the helper, exporter config/state, and reviewed policies there;
policy/config/state files are mode `0600`. Choose new output filenames. Select the
exact installed Aside Cookies database privately; there is no profile discovery
or fallback. `$ORIGIN` is the intended coordinator's origin, not a published
deployment URL. Use requested-only export for all-site operation; it does not
capture a full jar or export merely proposed sites.

Provision a separate `UMPI_BROWSER_SYNC_TOKEN` through private environment/secret
handling only after authorization. It must differ from control, executor, and
model credentials. Its [limited server role](../subsystems/browser-access.md#protected-http-surface)
includes approved snapshot requests, not task approval. `config-create` reads it
from the environment and stores it privately; never pass or print the token.

```sh
npm run browser -- helper-build --output "$PRIVATE/aside-cookie-export"
npm run browser -- config-create --config "$PRIVATE/browser-export.json" \
  --origin "$ORIGIN" --cookie-db "$COOKIE_DB" \
  --helper "$PRIVATE/aside-cookie-export" --state "$PRIVATE/browser-export-state" \
  --requested-sites
npm run browser -- authorize --config "$PRIVATE/browser-export.json"
```

For deliberately restricted export instead, replace `--requested-sites` with
`--approved-sites "$APPROVED_SITES"`, where the private JSON array contains reviewed
local policies matching the coordinator. Select exactly one mode. See the
[snapshot contract](../subsystems/browser-access.md#one-way-snapshots) for request
authority, domain-cookie scope, PSL alignment, and pre-export/upload checks.

For an explicitly isolated loopback coordinator only, add `--isolated-loopback`
to `config-create`; hosted origins require HTTPS. The export helper is compiled
with the macOS SDK and ad-hoc signed. First authorization may prompt for the exact
`Aside Safe Storage` / `Aside` item. Review and authorize only this narrow helper
in a private terminal. It does not change Keychain ACLs automatically.
Never grant broad permanent trust to `/usr/bin/security`, Node, a shell, or a general
interpreter. Keep the stable signed executable: rebuilding/re-signing changes its
code identity and can require new explicit authorization. A one-time approval
does not prove unattended access. Stop here if live trust/export is not authorized.

#### Refresh, choose snapshots, and maintain the installation

Only after separate credential-upload authorization:

```sh
npm run browser -- sync --config "$PRIVATE/browser-export.json"
npm run browser -- watch --config "$PRIVATE/browser-export.json"
```

`sync` makes one explicit export/upload attempt for the configured mode. `watch`
runs in the foreground until stopped. Preserve its private `refresh.sqlite`;
the [snapshot contract](../subsystems/browser-access.md#one-way-snapshots) defines
the per-site six-hour schedule, approximately one-minute request polling, and
failure/restart fences. The CLI installs no login item or OS background service.
Run `watch` under a separately configured process supervisor if unattended refresh
is intended; Umpi does not install one. Review private attempt/success metadata;
a running watcher is not proof of successful refresh or signed-in state.
Locked/denied Keychain access needs deliberate owner action.

Read `/api/browser/snapshots`. For unclaimed work only, review the selected
policy-matching snapshots, then post `{expectedVersion, snapshotIds}` to
`/api/browser/tasks/:id/cloud`. Use `snapshotIds: []` for anonymous execution or
a subset for saved sessions on selected sites only. This creates a fresh cloud
approval card; review and approve its new version, including every saved version
or no-saved-session choice. New exports never change a running task. Corrections
post `{expectedVersion, text}` to `/correct`; cancellation posts `{expectedVersion}`
to `/cancel`. Review actual stop and retained outcome before creating replacement
work. The same-Worker BrowserWorker is not security-isolated by its DO bindings.

Before a separately authorized hosted rollout, preserve private installation
values and existing Assistant/VaultSync/CodingWorker migrations, bindings, state,
and provider refresh ownership. Align `BROWSER_WORKER` → `BrowserWorker`, appended
`v4-browser-worker`, `BROWSER`, and the dedicated private `BROWSER_ARCHIVE` R2
binding. Provision/confirm Browser Run and R2 access; do not substitute Containers
or another subsystem's archive. Install only the distinct sync token secret.
Verify actual live routes, owner-bound `/browse`, provider session identity and
actual destruction before enabling/exporting live site state. Local Chromium or
a dry-run build does not verify hosted launch/connect/close/list semantics.

Over continuing operation, retain config, executor ID, origin binding, journal,
signed helper identity, and refresh metadata together. Review snapshot age and
pruning, failed attempts, pinned uncertain runs, browser/schema changes, and
provider active-session usage. Unsupported formats need a reviewed implementation
change, not profile copying or a decryption fallback. Re-review policy changes
and refresh local grants; old scopes do not silently expand. Keep observations,
screenshots, credentials, private account identifiers, and state out of shared
logs/source. Use the [verification runbook](verify-browser-sessions.md) before
relying on new browser/provider versions or claiming stronger guarantees.

### Operate proactive follow-through

This feature is implemented and verified in isolated workerd and a bounded hosted reference scenario. New scheduler state starts paused. No new credential, Worker Cron Trigger, binding, migration declaration, or always-running container is required. A code rollout must preserve Durable Object storage, provider refresh ownership, source-bridge state, executor journals, and native signing configuration.

After deployment, verify the live scheduler route before treating the feature as available. The deployment wrapper publishes the source-maintained Telegram menu after upload, but the globally unique Durable Object can briefly run older code; menu visibility is not proof of code cutover. Once verified, open `/schedule` in the owner's private Telegram chat and use its native Enable/Pause button. A button from an older settings version fails instead of overwriting newer settings.

Use natural conversation to request a concrete follow-up or custom return, with its useful time window and whether a notification is wanted. The agent records a responsibility and invokes scheduling tools; prose alone does not schedule anything. It must disclose when scheduling is paused. The 15-minute heartbeat reviews only eligible responsibilities. It does not discover work by scanning all old chats, personal interests, calendar entries, or vault files.

The protected `GET /api/schedule` shows settings, responsibilities, wake-ups, recent review outcomes, and the last check reason. `PUT /api/schedule/settings` accepts the current `expectedVersion`, `enabled`, and `quietHours` (`null` or distinct local `HH:mm` start/end). Keep personal quiet-hour choices in private runtime state. The configured `UMPI_TIMEZONE` determines their timezone. A scheduler-settings change is an owner action, not an agent tool or a phone form's permission grant. [The HTTP contract](../subsystems/assistant-runtime.md#protected-http-surface) defines creation, correction, and cancellation bodies.

Pausing preserves future intent but does not stop already-approved Mac work, text reminders, or installed device alarms. Cancelling/moving a wake or editing its responsibility invalidates its old review and unsent notification; it cannot undo an external effect or recall a send already in flight. Re-enable only after checking whether overdue work is still useful. One-shot expiry drops stale work; recurring missed occurrences coalesce.

For an unexplained silence, inspect `lastCheck`, the responsibility's next review/blocker, its wake expiry, recent structured run outcomes, model configuration, and delivery state. Empty/blocked work may correctly produce no model turn. A failed or unstructured review is retained without an automatic repeated nudge; reconcile its actual effects before explicitly scheduling another review. Foreground-interrupted reviews preserve useful eligibility. `held` delivery is paused/quiet, `cancelled` is invalidated, and `uncertain` is never an instruction to resend blindly.

Verification for a scheduling change must include an actual independent wake before the next heartbeat, a real process restart on the same isolated storage, stale-version rejection, cancellation, quiet outcomes, and foreground-priority behavior. Do not clone the hosted refresh credential into a test Worker. The [verification record](../learning/assistant-core-verification.md#proactive-scheduling-verification) distinguishes real alarms and native Pi tool rounds from live-model/Telegram evidence.

### Operate read-only mail follow-through

The [mail runtime contract](../subsystems/assistant-runtime.md#read-only-mail-follow-through) owns bounds, storage, triage, and unavailable actions. Source support is not evidence that a hosted installation has its secret, live route, menu, or a working Gmail grant. New mail settings start paused. The existing `/schedule` follow-through setting must also be enabled.

The Gmail grant may use the same owner-controlled Google Cloud project and Desktop OAuth client JSON as Calendar, but it must use its own consent and output credential. In that project, enable the Gmail API and add only `https://www.googleapis.com/auth/gmail.readonly` to the OAuth consent configuration. Keep the Calendar and Gmail refresh credentials separate. Do not replace `UMPI_CALENDAR_CREDENTIALS`.

`gmail.readonly` is a [restricted Gmail scope](https://developers.google.com/workspace/gmail/api/auth/scopes). Google's verification and restricted-data requirements depend on the OAuth audience, distribution, and whether restricted data is stored or transmitted through a server. An owner-operated installation does not justify documenting an exemption. Review the current [OAuth verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) before publishing or expanding the audience.

Authorize in a private interactive terminal. The client file and output directory must be owner-only and outside the repository:

```sh
GOOGLE_CLIENT_JSON="$HOME/.config/umpi/google/desktop-client.json"
npm run mail -- login --client-config "$GOOGLE_CLIENT_JSON"
npm run mail -- status
```

The loopback flow uses state and PKCE, requires an exact scope response, and refuses to replace an existing output. It stores `~/.config/umpi/mail/credentials.json` by default. `status` validates protected local presence and schema only; it does not prove refresh or Gmail access. Reuse of the client registration does not combine the Calendar and Gmail grants.

To add another mailbox, authorize it under its own account ID and choose that Google account in the browser. If the OAuth consent screen is in testing mode, first add that address as a test user in the Google Cloud project:

```sh
npm run mail -- login --client-config "$GOOGLE_CLIENT_JSON" --account domain
npm run mail -- status
```

After explicit hosted-deployment and credential-upload authorization, upload every stored mailbox as one Worker secret. The command assembles the grants in memory and sends them to `wrangler secret put` on standard input:

```sh
npm run mail -- upload-secret --config wrangler.local.jsonc
```

A single-mailbox installation can still install only `credentials.json` as `UMPI_GMAIL_CREDENTIALS`.

Never put the JSON in `wrangler*.jsonc`, `.dev.vars`, command arguments, source, screenshots, or shared logs. Preserve the existing Durable Object, migrations, model refresh owner, Calendar secret, Telegram configuration, and other private values during rollout. No Pub/Sub topic, push subscription, Cron Trigger, R2 bucket, or container is required.

After an authorized deployment, verify protected `GET /api/mail` reports `authorizationConfigured: true`; this is still not a successful provider read. Confirm the source-maintained Telegram menu was synchronized and open `/schedule` first. Then open `/mail` and choose the fixed initial boundary: now, 7 days, 14 days, or 30 days. The setting does not search older mail later. `Check now` queues a bounded read. Cursor expiry exposes a version-bound bounded re-scan control instead of silently reading the mailbox again.

To build the [situation record](../subsystems/assistant-runtime.md#situation-record) from existing mail, raise the lookback through the protected settings route (for example to 30 days) while mail is enabled. Every mailbox re-scans that window; unchanged threads are not re-triaged, but each is read once for facts. Expect roughly one minute of Gmail reading per 100 messages and one model turn per 15–40 remaining threads. Bulk tabs cost no model turns.

A large bootstrap or incremental change set spans multiple short lifecycle invocations. `scanInProgress: true` means a provider page token or bounded message-ID queue is saved in SQLite. During that state, the committed Gmail history cursor remains unchanged and model triage waits. Do not treat `lastStatus: partial` as lost coverage or trigger another bootstrap. The scheduler resumes the saved continuation; a transient interruption retries after one minute without discarding progress. A provider response beyond the continuation safety bound fails without advancing the cursor.

After all provider pages drain, Pi may need multiple size-bounded review turns. Application state accumulates their structured decisions and emits one final digest that lists the newest 15 items and counts the rest. Open `/mail` to review one selected item at a time. `Draft reply` creates review text in chat only. `Tomorrow` and `Handled` change private Umpi state only. They do not save a Gmail draft, send, mark read, archive, delete, or label. Pause preserves existing review records and stops checks; `/schedule` pause also stops them.

For private verification, use controlled synthetic or disposable threads around the selected cutoff. Observe: no item older than the exact boundary; persisted page continuation across a restart; no cursor advancement until the final page; one aggregate digest after all triage batches; no duplicate for an unchanged provider version; a new incoming message reopening handled state; a later sent reply resolving it; quiet-hour deferral; stale button rejection; and no Gmail mutation. Inspect `GET /api/mail/items` only through the control credential. Keep sender, subject, excerpts, links, and model output out of shared logs and fixtures.

For an expired cursor or unexplained silence, inspect `lastStatus`, `issue`, `scanInProgress`, `bootstrapAfter`, `nextSyncAt`, scheduler state, model status, and Telegram delivery state. Do not repeatedly widen or rerun bootstrap. Revoking Google access stops future reads but does not erase existing Umpi operational records, model-provider processing, or Telegram messages. Pause first, revoke through Google account controls, remove the Worker secret only under separate deployment authorization, and remove retained private state through owner-controlled storage administration when required.

### Operate the morning brief

Open `/brief` and choose **Enable at 03:30**. The existing `/schedule` follow-through setting must also be enabled. Enabling after that day's time starts the next morning; **Brief now** writes one immediately. Change the time through `PUT /api/brief/settings` with the current `expectedVersion`. A morning with nothing worth saying stays silent. Check `GET /api/brief` and the schedule run history when a brief is missing; the brief is a normal proactive notification, so quiet hours and pause also apply.

### Operate default checks

Calendar heads-ups, due-soon nudges, and stalled-commitment reviews are on by default once follow-through is enabled in `/schedule`. Inspect `GET /api/alerts` for the last calendar read, any calendar issue, and the next check. Change them with the current `expectedVersion`:

```sh
# Body example: {"expectedVersion": 1, "calendarLeadMinutes": 10, "dueSoon": true, "stalled": true}
PUT /api/alerts/settings
```

Heads-ups and nudges are plain Telegram messages; correct a wrong fact in chat (for example "that bill is paid") to stop its nudge.

### Operate journal writes

Close-out, intra-day additions, and check-ins run when follow-through is enabled and the private note workspace is connected. Inspect `GET /api/journal` for queued, written, and failed lines and the last issue. Change them with the current `expectedVersion`, for example `{"expectedVersion": 1, "checkIns": ["13:00", "18:00"], "closeOut": true, "intraDay": true}` to `PUT /api/journal/settings`.

The workspace depends on an active Obsidian Sync subscription. A lapsed subscription makes every preparation and journal write report "private note workspace is unavailable"; restore billing and then request preparation again.

### Operate daily-note preparation

The [runtime contract](../subsystems/assistant-runtime.md#daily-note-preparation) owns behavior and concurrency limits. New installations start paused and require explicit resource, credential-transfer, deployment, and activation authorization. Use bounded manual and automatic checks for fresh vault/calendar input, acknowledged upload, exact read-back, container inactivity, stale-edit rejection, and interruption recovery before enabling a real schedule.

#### Prepare the separate private sync client

Run these in your own private terminal. Login and encryption-password/MFA prompts must not be captured in chat or command arguments.

```sh
npm run vault -- login
npm run vault -- remotes
npm run vault -- setup --vault-id REMOTE_VAULT_ID --source-vault /path/to/desktop-vault
npm run vault -- sync
npm run vault -- export --output "$HOME/.config/umpi/headless/bootstrap.gz"
```

`REMOTE_VAULT_ID` is selected from the private remote listing, not stored in repository configuration. The source-vault argument inventories directory names only; it is never the sync target. `--root PATH` chooses a different owner-only client root outside the repository. Default state is under `~/.config/umpi/headless`: an isolated HOME, separate workspace, and a scoped-setup receipt. On macOS the official client uses HOME's `.obsidian-headless`; XDG alone does not isolate its account state. On Linux it uses the private XDG configuration directory.

Setup supports `--journals`, `--template`, and repeated `--exclude-folder` arguments. It selects bidirectional/conflict mode, disables configuration synchronization, and explicitly persists an empty attachment allow-list: the pinned CLI's empty `--file-types` option otherwise restores attachment defaults. Existing unrelated top-level directories are excluded, but root note formats and later-created directories can still sync. This is an operational filter, not least-privilege authorization to the remote vault.

An unfinished setup cannot sync/export. Repeating setup for the same unfinished isolated vault can finish its configuration; it cannot replace a completed client or a different vault. Configuration changes invalidate the saved receipt. Export requires stopped, acknowledged state and an unused private output path. Do not copy a running client, export the desktop profile, delete unresolved scratch blindly, or put the archive into Git/image layers. The archive contains usable account/encryption material and private notes.

Obsidian Headless 0.0.14 is an official beta CLI, not a copied or patched SDK. A reported standard-encryption setup issue can prevent completing setup; do not invent an encryption password or substitute desktop secrets. Keep automation paused if the actual client cannot complete setup and a disposable round trip.

#### Authorize the read-only calendar

Provide an owner-only Google Desktop installed-client JSON outside the repository, then authorize a separate grant:

```sh
npm run calendar -- login --client-config "$HOME/.config/umpi/calendar/client.json"
npm run calendar -- status
```

The login opens a local callback and prints its browser authorization URL. It requests only `calendar.calendarlist.readonly` and `calendar.events.readonly`, checks the returned scopes, and saves a new private refresh credential without replacing an existing file. Do not reuse a broader credential from another client. The default output is `~/.config/umpi/calendar/credentials.json`; local status is presence/schema validation, not a successful calendar read.

Google's [Testing audience](https://support.google.com/cloud/answer/15549945?hl=en) expires Calendar authorizations after seven days. For a continuing personal installation, configure the OAuth registration's homepage, privacy, terms, and authorized-domain information, deliberately publish it, then authorize a fresh grant. The coordinator provides informational pages; no second domain or public login flow is needed. Publishing is not verification: an unverified-app warning and user cap can remain. Google's [personal-use exception](https://support.google.com/cloud/answer/13464323?hl=en) is distinct from publishing and does not guarantee that a credential can never expire or be revoked.

When an old output already exists, use `--credentials` with a new private destination. Verify an actual read before deliberately replacing the installation's own Calendar credential and updating only its Worker secret. Preserve other clients, broad legacy grants, support contacts, and model refresh ownership.

After explicit cloud authorization, install that JSON as the `UMPI_CALENDAR_CREDENTIALS` Worker secret using Wrangler's private stdin flow. Do not put its contents in `wrangler*.jsonc`, command arguments, source, or logs. An absent grant produces a coverage gap; it must not masquerade as “no meetings.”

#### Provision and verify before enabling

Keep `VAULT_SYNC`, the `v2-vault-sync` migration, the container definition, and `VAULT_ARCHIVE` aligned in public/private configuration while preserving private identities. Provision the intended private R2 bucket and confirm account access to Containers/R2 before an authorized deployment. Workers Paid is not proof that every required resource is already provisioned. The dedicated image uses Linux/amd64 and a deny-all Docker context allow-list; it must never be shared with model-controlled coding.

After the new owner routes are actually live, inspect the provisioning generation and deliberately upload the private archive:

```sh
npm run vault -- status "$COORDINATOR_ORIGIN"
npm run vault -- upload "$COORDINATOR_ORIGIN" \
  --archive "$HOME/.config/umpi/headless/bootstrap.gz" --expected-revision 0
```

Use the observed generation, not `0` on a replacement. Pass matching custom journal/template flags if setup used them. The control token comes from the private environment, not argv. Upload streams an exact-length bounded body, validates/restores the archive, commits its pointer, and leaves daily scheduling paused. A successful provisioning response explicitly says `syncVerified: false`; it does not prove a valid live login, remote upload, or phone delivery.

First exercise a disposable note through the real provider: download, write, acknowledged upload, second-client visibility, a concurrent nonempty edit, and interrupted upload/reconciliation. Direct journal editing uses normal Sync conflict semantics: concurrent remote deletion/clearing can be overwritten, and an offline device's unseen changes cannot be protected by local preflight. Retained before/after text is evidence, not a distributed lock or automatic undo.

Then verify fresh calendar coverage, the intended timezone/time, current approved core context, and a real native Pi preparation. Open `/plan` to prepare today and inspect the result. Only after those checks enable daily preparation; `/schedule` must also be enabled. The default preparation time is local `02:30`, adjustable through the protected settings route. Check a real durable wake and actual upload rather than treating a registered deadline as completion. Normal success should remain quiet.

For unknown uploads, inspect the exact retained write through the [owner API](../subsystems/assistant-runtime.md#protected-http-surface) and the current note. Explicit prepare-today can resume only the retained same-day intent while its brief/core authority is still current. A changed source or expired day needs owner reconciliation; release with its expected status only after review. Release does not undo a remote edit or retract I/O already dispatched. Never overwrite a retained intent with a newly guessed patch.

Compute is on-demand, not a continuously running Obsidian process. Actual container duration, R2 storage/operations, Worker/DO usage, and model work still count. The adapter requests destruction after each operation and retains an idle-shutdown fallback. No zero-cost claim or runtime forecast is justified before measuring the real workspace.



### Native app development

`ios/project.yml` is the XcodeGen source; regenerate `ios/Umpi.xcodeproj` after changing project settings or source membership. Use Xcode with an iOS 26-or-newer SDK and XcodeGen. The implementation was built with Xcode 27. The app supports iOS 18 and later, with alarms gated to iOS 26.

The approved reusable wordmark assets live in `ios/Umpi/Assets.xcassets/AppIcon.appiconset`: `AppIcon.png` is plum on lilac, `AppIcon-dark.png` reverses those colors, and `AppIcon-tinted.png` supplies grayscale for system tinting. Retain both colorways for reuse outside the app. The opaque 1024-pixel images leave corner masking to iOS. Regenerate all appearances on macOS from the checked-in drawing source before building:

```sh
swift ios/Tools/GenerateAppIcon.swift ios/Umpi/Assets.xcassets/AppIcon.appiconset
```

```sh
xcodegen generate --spec ios/project.yml
open ios/Umpi.xcodeproj
```

Select the Umpi scheme and an installed simulator. Keep simulator ad-hoc signing enabled: `CODE_SIGNING_ALLOWED=NO` prevents real Keychain pairing in the verified environment. A simulator build needs no private Apple account settings:

```sh
xcodebuild -project ios/Umpi.xcodeproj -scheme Umpi \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$TMPDIR/UmpiDerivedData" \
  CODE_SIGN_IDENTITY=- build-for-testing
```

For a physical device, create the private signing override once:

```sh
cp -n ios/Config/Signing.example.xcconfig ios/Config/Signing.local.xcconfig
chmod 600 ios/Config/Signing.local.xcconfig
```

Set the real team, app identifier, and APNs environment only in that ignored file. The widget identifier derives from the app identifier. Select a connected, developer-enabled device in Xcode and use a valid signing/provisioning configuration. Personal distribution does not bypass entitlement requirements. Never publish signing output containing private identifiers.

#### Pair and operate

The coordinator must run the companion-enabled code; building the app does not deploy the Worker. After deployment, send `/pair` to the owner-bound Telegram bot. Alternatively, the protected control API can issue a code with `POST /api/companion/pairings`. Enter the trusted server origin and the short-lived code in the native pairing screen. Do not put the control token or model credentials in the app.

Production pairing requires HTTPS. Debug builds additionally allow loopback HTTP for an isolated simulator coordinator; they do not permit arbitrary cleartext remote origins or redirects. Pending claims recover with the same securely saved credential. If a code or origin is wrong, explicitly abandon the pending claim and pair again; revoke the old device through owner controls if its revocation could not be confirmed.

Use Workflows to create/edit native forms or Ask Umpi to request supported compositions. Local drafts survive refresh and restart. Review stale edits in the queued-change UI rather than discarding them or silently rebasing them. Activity shows requests, questions, jobs, and device outcomes. Command approval always shows the exact version, command, folder, and timeout separately from generated workflow controls.

Settings provides OS permission requests and separate remote-effect consent. Keep per-action review unless standing consent is intended. Foreground state refreshes every 12 seconds; background refresh and pushes are best effort. Disconnect attempts revocation and explicitly clears local data, but does not cancel installed alarms or notifications.

#### Configure push deliberately

Push is optional for foreground operation. A signed, push-enabled installation needs `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY` (complete PKCS#8 PEM), and `APNS_BUNDLE_ID`. The topic must match the private app identifier; sandbox/production registration must match its entitlement and provider key. Keep all four private, including the identifiers. Provision only those four fields through an authorized non-echoing secret operation, not command arguments, checked-in settings, or an indiscriminate vars-file upload. Preserve the existing control, executor, and Telegram secrets.

Prefer a dedicated topic-specific key rather than sharing an unrelated app's key. [New APNs keys are environment-specific](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns); do not assume a sandbox key can send production notifications. A production-signed app needs matching production configuration; changing only `APS_ENVIRONMENT` is insufficient.

Store the downloaded key and installation metadata in an owner-only private directory outside the repository. A signed development bundle can also be retained there for installation; never publish that directory or a working-directory archive. Xcode automatic signing can provision the app and extension without an App Store listing. Verify the built app's signature, team/app identity, and `aps-environment` before installation, without printing private identifiers.

Hosted Workers `fetch` reached both APNs endpoints in the isolated protocol probe. Local workerd did not; do not interpret that local transport failure as proof that hosted delivery is impossible. Neither result proves signed-device delivery. Verify actual notification presentation, alarm schedule/cancel/ringing, and Live Activity updates on the intended phone before relying on them. The [companion contract](../subsystems/phone-companion.md) owns result and uncertainty semantics.

#### Verify native changes

Run the UmpiTests target on an installed simulator, and also on a pre-iOS-26 runtime when changing unsupported-alarm behavior. Use the simulator's actual name/ID from `xcrun simctl list devices available`:

```sh
xcodebuild -project ios/Umpi.xcodeproj -scheme Umpi \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath "$TMPDIR/UmpiDerivedData" \
  CODE_SIGN_IDENTITY=- -only-testing:UmpiTests test
```

UmpiUITests exercises real pairing, workflow creation, draft refresh/relaunch, and persisted saves against a real isolated coordinator. Supply `UMPI_UI_TEST_ORIGIN` and a fresh `UMPI_UI_TEST_CODE` to the **test runner environment**, using private scheme settings or the generated `.xctestrun` file's UmpiUITests `EnvironmentVariables`. The debug app only prefills the form; pairing and all network/state operations remain real. Use a clean simulator session for this test. Without these inputs the UI test skips; a skipped test is not UI verification. Never commit populated test settings or result bundles.

Keep test credentials, state, screenshots, and private generated test settings outside the repository and remove them afterward. Also launch the app, inspect its actual surfaces, and exercise server-authored updates without manual refresh. Record simulator evidence separately from physical-device signing, push delivery, alarm ringing, and lock-screen behavior.

### Core context and selected vault sections

Core context uses the existing coordinator's Pi Durable SQLite storage. The CLI reads `UMPI_CONTROL_TOKEN` from the same private `.dev.vars` mechanism as the auth command. Never pass the token as an argument or print the full context in shared logs. Commands below print counts, revisions, and pending-source status only.

Set `COORDINATOR_ORIGIN` locally to the intended installation's origin. The hostname below is an example, not a deployed service; keep the real value out of published instructions and shared logs.

```sh
export COORDINATOR_ORIGIN="https://umpi.example.com"
```

Inspect an installation before provisioning it:

```sh
npm run memory -- status "$COORDINATOR_ORIGIN"
```

For a new, empty installation only, set `VAULT` to its absolute local vault directory and select reviewed sections explicitly:

```sh
npm run memory -- sync "$COORDINATOR_ORIGIN" --vault "$VAULT" \
  --expected-revision 0 \
  --source 'background:background:personal/Agent context.md#Confirmed background and assistant role' \
  --source 'routine:preferences:personal/Routine and planning.md#Intended rhythm' \
  --source 'capacity:preferences:personal/Routine and planning.md#Capacity constraint' \
  --source 'planning:preferences:personal/Routine and planning.md#How the owner wants to plan' \
  --source 'workstreams:workstreams:personal/Current workstreams.md#Active areas'
```

These are section mappings, not embedded owner facts. Adapt them deliberately for another vault. The selector format is `id:kind:relative/path.md#Exact heading`; kinds are background, preferences, and workstreams. Do not repeat bootstrap against an already populated installation or bypass a stale revision. Later sync uses the stored mappings; another explicitly supplied selector may add a reviewed source, but cannot silently remap an existing ID.

Run one synchronization, or keep a foreground bridge running while the Mac is awake:

```sh
npm run memory -- sync "$COORDINATOR_ORIGIN" --vault "$VAULT"
npm run memory -- watch "$COORDINATOR_ORIGIN" --vault "$VAULT"
```

Watch checks once per minute by default. `--interval-ms` accepts at least 5,000 milliseconds; runs never overlap. Ctrl-C or SIGTERM stops it. Network failures are reported without private response contents and retried at the next interval. Source or revision conflicts stop the watcher for review. No login item or system service is installed by these commands. If the bridge is stopped or the Mac sleeps, cloud conversation continues using its stored core; pending note corrections wait.

The bridge reads only mapped files and writes only mapped section bodies. It preserves unrelated text and rejects unsafe paths, symlinks, ambiguous or overlapping headings, malformed boundaries, and replacements that escape their section. Headings inside frontmatter or fenced code are not source headings. No `.obsidian` configuration is changed. A successful local write is not proof that Obsidian Sync delivered it to a phone or another computer.

On a conflict, compare the current source section with the pending runtime correction through the protected API. Reconcile the desired content deliberately; do not blindly replace the remote document with the latest revision number. A prior local replacement may already be present if the remote acknowledgement conflicted. The next sync acknowledges matching text without writing it again, but different edits remain a conflict. Preflight checks do not provide a distributed lock with other editors or devices.

#### Review and restore memory

Use `/memory` in the owner's private Telegram chat. Open a pending review, read its complete Before and After text, then choose Approve or Reject. The agent can propose an update, but cannot approve its own work. Creating or rejecting a proposal changes neither the automatically injected core context nor its Obsidian source. Approval commits the reviewed topic and queues the accepted text for the existing source bridge; it is not confirmation that Obsidian Sync has delivered it everywhere.

History → revision → topic shows retained text. **Review restore** creates a separate current-before/historical-after card; **Approve** on that card is the actual mutation. Restoration changes only the selected topic, preserves unrelated current topics, and requires the same active source mapping and category. Restore deleted or remapped sources deliberately in Obsidian instead. A stale review cannot apply; open `/memory` and review a new proposal rather than accepting a silently rebased change.

Owner edits in explicitly selected Obsidian sections still synchronize automatically. Changed imports and approved updates are journaled, including source acknowledgements; adjacent revisions may therefore contain the same text with different synchronization metadata. Unchanged imports and rejected proposals do not create new core revisions. History starts from the current baseline captured by the first successful proposal or changed import after this feature is installed. Reads do not manufacture a baseline, and older unavailable revisions cannot be reconstructed.

For administrative clients, the [protected HTTP surface](../subsystems/assistant-runtime.md#protected-http-surface) exposes pending reviews, exact review status, decisions, paginated history, and restoration proposals. Review the exact stored before/after content before deciding its ID. Approval accepts no replacement fields. Never write a client that silently approves all pending changes or uses source import as a workaround for agent approval. Only the control credential or authenticated owner Telegram interaction can decide; executor and paired-device credentials cannot.

If a review card was only partially delivered or has an uncertain send outcome, use `/memory` and open that review again to explicitly request a fresh complete card. Do not repeatedly click a callback from an unrelated or incomplete message. Automatic delivery does not blindly retry uncertain Telegram sends. A normal code deployment preserves existing core context, the running bridge, and credentials; do not reset the Durable Object or re-bootstrap memory for this upgrade.

The [runtime contract](../subsystems/assistant-runtime.md#native-core-context) owns persistence, prompt inclusion, admission limits, and mutation semantics. This bridge is not full-vault retrieval, a nightly journal planner, or a headless Obsidian Sync client.

### Recover an interrupted Mac

```sh
npm run mac -- status
```

If a journal reports uncertainty and pauses new execution, keep the same private
`--config PATH --state-dir PATH` for every command:

1. Stop the daemon.
2. Inspect original shell/coding processes and their effects. Confirm the earlier foreground groups stopped; do not kill reused PIDs or mistake a missing connection for stop.
3. Inspect recorded task-owned Aside target IDs and possible popup descendants privately. Normal close works in the original owning REPL. Lost-REPL attachment is borrowed; `closeTab` detaches, and `window.close` is not general recovery. Confirm actual owned-tab absence or explicitly close the reviewed owned tabs yourself. Never close user tabs or guess unknown descendants from their URL.
4. Preserve config, origin binding, journals, executor ID, and retained outcomes. Browser uncertainty pauses only its independent lane; shell/coding share their pause.
5. Only after confirming **all prior shell, coding, and browser work** stopped, clear recovery pauses:

```sh
npm run mac -- resume --confirm-stopped
npm run mac -- run
```

Resume records explicit stopped reconciliation; it does not replay uncertain work,
erase history, undo effects, or turn the outcome into success. Deliver that saved
report on reconnection. For an uncertain browser task, read the current protected
task/version and, after native stopped reconciliation is acknowledged, post
`{expectedVersion, confirmStopped: true}` to `/api/browser/tasks/:id/reconcile`.
For cloud uncertainty this route requests provider stop as well and refuses an
unconfirmed stop. Submit replacement work only after reviewing prior effects.
An ordinary network disconnect requires reconnecting with the journals intact,
not resuming or rerunning accepted commands.

### Checks

```sh
npm run typecheck
npm test
npm run build
```

`build` is a Wrangler **dry run**, not a deployment. Regression tests use isolated storage and real local processes where needed; they do not use production credentials or a live Telegram bot. The [verification record](../learning/assistant-core-verification.md) distinguishes those tests from the real-model smoke scenario.

For a change to action behavior, also run the local system: send a real model request, inspect the persisted action, perform any required approval, and observe its actual effect and reply. Include restart or disconnect boundaries when changing ownership or scheduling.

### Hosted operation

The public `wrangler.jsonc` contains the shared Worker definition, placeholder Worker/R2 names, no account ID or custom-domain binding, and a generic UTC default. It disables `workers.dev` and preview URLs. It is suitable for local development and dry-run builds, not an installation's production deployment.

Deployment uses ignored, owner-only `wrangler.local.jsonc`. Existing private configuration must not be replaced. For a new deployment only, create it once:

```sh
cp -n wrangler.jsonc wrangler.local.jsonc
chmod 600 wrangler.local.jsonc
```

Set a unique Worker name, real R2 bucket names, `account_id`, installation variables, and `routes: [{ "pattern": "umpi.example.com", "custom_domain": true }]` in the private file. Replace every `replace-with-...` value and the example hostname locally. Preserve disabled alternate URLs. Keep shared entry points, bindings, migrations, and compatibility settings synchronized with public configuration without overwriting private identities.

Cloudflare provisions the domain's DNS and certificate through this configuration. The Telegram webhook and protected API share one hostname; neither requires a second domain. See [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) and [preview URL controls](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/). `npm run dev -- --config wrangler.local.jsonc` can use these non-secret installation settings locally; it does not provision a hosted service.

Use the configured bot from Telegram on desktop or phone. Keep its handle and owner/chat IDs in private installation records. Send ordinary text or `/status` for a readable summary. Review the exact command and folder, then use its native Approve or Cancel button. Edited commands require fresh approval; an old button cannot approve the revision. Clarification questions offer native options, but typing your own answer also works. `/approve ID VERSION` and `/cancel ID [VERSION]` remain manual alternatives using IDs/versions from protected job status. The same origin serves public app information at `/`, `/privacy`, and `/terms`, not web chat; `/health` returns liveness. The public pages contain no sign-in flow or assistant state.

Confirm the Mac configuration points at the intended origin. Start the executor when it is not already running:

```sh
npm run mac -- status
npm run mac -- run
```

No local Worker process is needed for hosted use. No LaunchAgent or login item is installed. The executor must be running and the Mac awake for new native execution. Keep its stable ID and journal. Do not edit only `serverUrl` to switch coordinators: the journal has a matching origin binding that must be reconciled before a handoff. Review the [polling cost boundary](../subsystems/mac-executor.md#local-state) before leaving the daemon running continuously.

Inspect protected hosted status without putting a token in command arguments. Export `COORDINATOR_ORIGIN` as above before running this Node command:

```sh
node --env-file=.dev.vars --input-type=module <<'JS'
const origin = process.env.COORDINATOR_ORIGIN;
if (!origin) throw new Error('Set COORDINATOR_ORIGIN to the intended installation');
const response = await fetch(new URL('/api/status', origin), {
  headers: { authorization: `Bearer ${process.env.UMPI_CONTROL_TOKEN}` },
  redirect: 'error',
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error(`Hosted status failed: HTTP ${response.status}`);
const state = await response.json();
console.log({ status: response.status, modelConfigured: state.model.configured });
JS
```

This is a Node command; its `redirect: 'error'` is supported there. Worker outbound Telegram code instead uses `manual`, because workerd rejects `error`. Neither path follows redirects. `model.configured` is credential/configuration presence, not proof of a successful provider request.

#### Deploy a code change

```sh
npm run typecheck
npm test
npm run build
npm run deploy
```

`build` remains a dry run against the public configuration; `deploy` explicitly uses `wrangler.local.jsonc` and changes production. Missing private configuration is an error, not a reason to deploy the public template. To check packaging without deployment, use `npm run deploy -- --dry-run --outdir dist`. Preserve the Worker name, Durable Object class/binding, migration history, and private credential state. A routine code deployment does not need another OAuth login, credential sync, or webhook registration. A change to accepted Telegram update types does require updating the webhook filter below. Keep the custom-domain and disabled alternate-URL settings in the private config. Worker and DO code can propagate at different times for seconds to minutes; confirm changed behavior, not just upload success. Continuous executor, context, or snapshot polling can keep the previous Durable Object instance active during that window. If protected status still reports the previous model after the deployment reaches 100 percent, pause only the known supervised pollers, allow the object to become inactive, restart every paused poller, and confirm their connections before the model smoke. See [Cloudflare code update semantics](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates).
For a Telegram presentation change, send a synthetic conversational reply containing a heading, bold and italic text, a list, inline and fenced code, a block quotation, and an HTTPS link. Verify the actual Telegram client renders each construct without visible Markdown delimiters. Also verify the protected control channel retains the original Markdown. Native approval cards must continue to preserve literal command text through their explicit entities.

After a successful real deployment, `deploy` also synchronizes the configured owner's Telegram command menu. Dry runs, help, and failed deployments do not publish menu settings. The Node command loads private `.dev.vars` when present; deployment automation can instead supply `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, and `TELEGRAM_CHAT_ID` through its environment. Matching positive owner/chat IDs are required.

#### Maintain the Telegram command menu

`src/cli/telegram.ts` owns the argument-free menu list. Add a supported command and description there when adding its handler. The current menu offers `/pair`, `/status`, `/memory`, `/schedule`, `/plan`, `/code`, and `/browse`; contextual approvals, memory decisions, and scheduling controls stay on their relevant messages. The menu is scoped to the owner's private chat, not the bot's global command list. BotFather is not needed for updates.

To publish or repair just the menu without another deployment:

```sh
npm run telegram -- sync-menu
```

The command uses [setMyCommands](https://core.telegram.org/bots/api#setmycommands) with a chat scope and the default language, then [setChatMenuButton](https://core.telegram.org/bots/api#setchatmenubutton) for that private chat. It verifies both through readback. It sends no messages and does not change webhook routing or global menu settings. Language-specific overrides, if separately configured, are not changed. Telegram clients may need the chat reopened to refresh their cached menu.

Menu updates are repeatable settings operations, unlike message delivery. If synchronization fails after deployment, the Worker is already deployed; the command exits unsuccessfully and explicitly says so. Run the menu-only command to reconcile partial changes instead of redeploying. Network/API errors do not print token-bearing URLs or Telegram response bodies.

#### Provision or rotate credentials deliberately

The hosted service requires six Worker secrets: `UMPI_CONTROL_TOKEN`, `UMPI_EXECUTOR_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OWNER_ID`, and `TELEGRAM_CHAT_ID`. Control and executor tokens are distinct. The ignored, mode-0600 `.dev.vars` is the local administrative source for these values; do not inspect it with context-printing tools. Model selection and timezone are non-secret Wrangler variables; deployment identities and personal settings still belong in private configuration.

For an authorized first provisioning or rotation, send only those six fields as a JSON object to `npx wrangler secret bulk --config wrangler.local.jsonc` on stdin from a non-echoing local process. Do not pass values in arguments, upload the entire vars file, or create a plaintext temporary export. Changing secrets is a deployment; recheck authenticated status after propagation.

Register the webhook at `/telegram/webhook` on the private installation's origin, with `allowed_updates: ["message", "callback_query"]` and the configured `secret_token`. Both update types are required for native controls. Inspect `getWebhookInfo` before changing routing. Use `setWebhook` with `drop_pending_updates: false`; do not discard queued owner messages or take over another bot's webhook. Bot API URLs contain the bot token, so use a non-echoing script rather than a token-bearing shell command. See the [Telegram Bot API](https://core.telegram.org/bots/api#setwebhook).

After a completed handoff, the hosted Durable Object is the sole OAuth refresh owner and retired local copies must stay retired. An empty local auth status is then expected. For a genuinely needed replacement login:

```sh
npm run auth -- login anthropic
npm run auth -- sync "$COORDINATOR_ORIGIN" anthropic
```

Confirm the hosted upload and a real model turn before retiring the newly created local copy:

```sh
node --import tsx --input-type=module -e 'import { FileCredentialStore } from "./src/model/file-store.ts"; await new FileCredentialStore().delete("anthropic");'
```

To switch an active installation to another provider, keep the bot usable during the change:

1. Deploy the code that accepts the new provider while private configuration still selects the old one.
2. Complete the new independent login and sync it. If sync returns HTTP 400, the Durable Object can still be running earlier code; a rejected sync stores nothing, so retry after the cutover.
3. Change `UMPI_MODEL_PROVIDER` and `UMPI_MODEL_ID` in `wrangler.local.jsonc` (and `.dev.vars` for local use), then deploy again.
4. Wait until protected status reports the new provider, send a real control or Telegram message, and then retire the local copy.

Existing main conversations take the configured model and effort when the coordinator starts.

Never resync a stale copy over a coordinator that may have refreshed it. Do not reactivate a stopped local Worker with cloned credentials. [Model authentication](../subsystems/model-auth.md#independent-storage-and-explicit-handoff) owns the handoff and trust rules.

After relevant changes, exercise owner-only admission, actual model/tool execution, confirmed Telegram delivery, duplicate updates, version-bound command approval, reminders, and Mac reconnect as appropriate. A Telegram `sent` record with a message ID proves API acceptance, not human readership. Inspect failed/uncertain sends before any manual resend; deployments do not automatically replay them. The initial pre-fix uncertain smoke records are retained as history.

Bot chats are not end-to-end-encrypted Secret Chats. No Telegram Premium subscription is required for ordinary bot messaging.

### Public-source and private-installation boundary

The repository contains reusable software and generic examples, not an owner's operational profile. Keep real domains, handles, account IDs, personal context and vault contents, device identities, and Apple team/key/app identifiers private even when a value is not an authentication secret. The [phone companion design](../subsystems/phone-companion.md#personal-distribution-and-public-source-safety) owns native signing and pairing requirements.

Private deployment settings use `wrangler.local.jsonc`; native signing settings use `*.local.xcconfig`. Signing keys, provisioning profiles, build archives, dependencies, and per-user Xcode state are ignored. Private runtime data stays outside the repository as specified by each subsystem. Ignore rules are a guard against accidental staging, not encryption or protection against `git add -f`.

Before publishing, inspect all tracked and unignored candidate files, including documentation, examples, fixtures, generated assets, screenshots, and lockfiles. Check for both credential material and owner-identifying values. Use metadata-only checks for private files; never echo their contents into review logs. Review Git author names/emails as well as staged content. Check all refs and history: changing the current file or adding an ignore rule does not remove previously committed data. Revoke exposed credentials if any are discovered; discuss history rewriting before doing it.

Publish reviewed Git content, not an archive of the working directory: ignored local files still exist on disk. This boundary requires another review when app signing, APNs, integrations, or deployment configuration changes.

## History

- 2026-10-11: Added local setup, independent login, private persistence, hosted configuration, and recovery boundaries.
- 2026-10-11: Added context synchronization, native companion generation/signing, Telegram menu synchronization, and proactive-scheduling operation.
- 2026-10-11: Added private Headless Sync, read-only Calendar setup, isolated container/R2 provisioning, and concurrency limits.
- 2026-10-13: Added daily planning, private-copy coding, source-only cloud coding, native browser export, and background-subagent operation.
- 2026-10-13: Added independent voice-transcription OAuth setup and explicit refresh-ownership handoff.
- 2026-10-14: Replaced private installation chronology and resource names with reusable setup, verification, and placeholder guidance.
- 2026-10-15: Added separate read-only Gmail authorization, lossless bounded continuation, aggregate digest behavior, operational controls, revocation, and verification guidance.
- 2026-10-15: Added live verification guidance for channel-specific conversational Markdown rendering through Telegram-native entities.
- 2026-10-19: Made Claude subscription login the default and recorded the zero-downtime provider switch.
- 2026-10-19: Added multi-mailbox login and secret upload, the 30-day situation backfill, and morning brief operation.
- 2026-10-19: Added default-check operation.
- 2026-10-19: Added journal-write operation and the Obsidian Sync billing failure mode.
