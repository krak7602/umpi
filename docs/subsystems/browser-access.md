---
title: Browser access and authentication snapshots
aliases: [Aside integration, offline browsing, cloud browser access]
updated: 2026-10-14
---

# Browser access and authentication snapshots

## Current

### Implementation status

Browser access provides a Mac-first native Aside lane and an optional one-way snapshot lane using Cloudflare Browser Run. New installations start restricted and native-disabled. An owner can enable public-site eligibility and requested-only snapshots, but task approval remains separate.

Bounded reference scenarios completed public-page tasks through native Aside and Browser Run after confirmed owned-tab/session stop. Encrypted capture metadata reached dedicated R2 storage without transferring the full profile. This does not establish that every website session is portable.

The [operation runbook](../runbooks/local-development.md#operate-browser-tasks)
owns setup and recovery commands. The [verification runbook](../runbooks/verify-browser-sessions.md)
owns repeatable checks. [Portability evidence](../learning/browser-session-portability.md)
preserves anonymized account-session experiments; [integration evidence](../learning/assistant-core-verification.md)
records implementation checks. [Architecture](../architecture.md) owns placement
and cost assumptions. The [snapshot decision](../decisions/2026-10-11-browser-snapshots.md)
records the original rationale, not a second current specification.

### Owner-approved tasks

A foreground owner request proposes one complete task: goal, sites, exact start
URLs, and a time limit of 1 second to 15 minutes. Owner settings default to
`allSites: false`. An owner can enable all public HTTPS site eligibility with a
version-bound settings change. This changes eligibility, never task approval.
Restricted mode uses independently registered site IDs. All-site mode also accepts
`{startUrl}` and derives a policy automatically; there is no fixed website registry
limit, but each task still permits at most 16 sites.

An automatic policy uses the registrable domain, including private Public Suffix
List (PSL) entries, as its title and `domain`. Its stable ID is `web-` followed by
the first 32 hexadecimal characters of SHA-256 of that domain. Navigation and
actions cover only that domain and its subdomains. Public URLs require HTTPS,
the default port, no embedded credentials, and a public DNS hostname, not an IP
literal, private/special-use host, or bare public suffix. `resources: "public"`
allows ordinary public HTTPS resources under the same public-URL checks; it does
not expand action scope. These hostname checks are not DNS pinning or DNS-rebinding
isolation.

Exact policies retain canonical `origins`, exact `cookieHosts` and `cookieNames`,
and exact cloud `resourceHosts`. Domain policies have empty exact cookie lists and
include all supported cookie names only for the approved domain/subdomains.
Canonical policy JSON includes optional `domain` and `resources`; the coordinator
versions and hashes it. A restricted Mac requires matching local policy digests.
An all-site-enabled Mac accepts approved public-site policies without individual
grants, but still validates assignments and digests.

Every task needs version-bound owner approval. Native Telegram `/browse` opens
retained tasks and review cards with the full goal, corrections, sites, time limit,
and execution lane. Long cards preserve all constraints in ordered chunks; every
chunk must have confirmed delivery before the exact-message Approve/Cancel token
can act. Stale or partially delivered cards fail. The protected HTTP surface supplies equivalent
controls. Model proposals can derive eligible-site metadata, never capture authority.
Neither the model nor scheduling can approve work, register exact policies, grant
Mac access, export credentials, or authorize cloud execution.

Corrections update the existing task. Active work keeps its owner, tabs, chosen
snapshot versions, and original deadline. A settled continuation needs fresh
approval. A correction cannot widen the fixed sites or undo an earlier website
effect; changed site scope needs a new reviewed task. Purchases, posts, messages,
and account changes require explicit intent in the approved goal. Website content,
links, ads, and screenshots are untrusted data, never new authority.

Browser work has its own lane, separate from the Mac shell/coding slot and their
recovery pause. A claimed or uncertain Mac task never migrates to cloud because
the Mac is silent. Only unclaimed work can be offered for cloud execution; the
owner must separately review the cloud lane's fixed saved-session selection.
`snapshotIds: []` starts every site anonymously; a subset imports only the selected
sites' cookies. Omitted sites start with empty cookies. Each selected snapshot
must match its task site's current policy and capture-age bound. Approval cards
distinguish a saved version from no saved session. Later exports do not change
the approved selection or running contexts.

### Browser model and effect boundary

A browser task uses its own durable model conversation. Its tools are typed
navigate, observe, click, fill, supported key press, screenshot, own-task read,
and finish. It has no arbitrary JavaScript/REPL/MCP, shell, coding, vault, core,
cookie/storage, encryption-key, credential-export, or password-manager API.
Internal driver callbacks are fixed implementation code, not model-supplied code.

Navigation and actions stay within the approved exact origins or domain/subdomain
scope. HTTP loopback is available only in an explicitly isolated local installation;
automatically requested public sites require HTTPS.
Observations contain a fresh opaque snapshot ID and refs. Actions reject
stale refs and forbidden password, credential, and file controls, including
controls changed after observation or by focus handlers. Displayed URLs omit
query and fragment. Trees are bounded to 64 KiB UTF-8, PNG images to 1 MiB,
encrypted snapshots to 2 MiB, and each run to 256 operations.

Each operation is durably admitted before its primitive effect. Its identity binds
task, run, and request digest. Exact replay returns a retained receipt; changed
arguments fail. Loss after dispatch is uncertain, not permission to click, submit,
or start again. Completion requires actual observation evidence and actual owned
browser close, not merely a successful RPC or model claim. Cancellation requests
stop; it does not roll back website effects. Retained uncertainty blocks replacement
work until actual stop and explicit owner reconciliation.

### Native Aside lane

The Mac daemon polls the authenticated coordinator and uses local
`aside mcp --host local` through a private stdio transport. Only generated `repl`
calls drive the documented wrapper's `openTab`, snapshots, page primitives,
`listBrowserTabs`, and `closeTab`. The integration does not require Aside Pro,
remote Channels, cloud handoff, or a Worker spawning a Mac process.

Native tasks open marked, task-owned tabs in the existing Aside profile. They
never attach to, edit, or close user tabs. The profile and website authentication
remain on the Mac. **Native Aside is not a network sandbox:** approved action
origins do not contain all requests, page scripts, or shared-profile/server effects.

Normal stop closes pages in their original owning REPL and checks that recorded
target IDs disappeared. The public popup event exposes only URL/window name, not
a descendant target ID. A popup or lost watcher makes stop uncertain; unknown
descendants require owner review, not guessed closing by URL or tab differences.
After REPL loss, a reattached page is borrowed and `closeTab` only detaches it;
`window.close` did not close an ordinary navigated tab in the actual probe. Recovery
therefore checks exact known-target absence and retains ownership/pause when it
cannot prove stop. It does not pretend reconnection closed the browser.

### One-way snapshots

The only direction is **Mac → encrypted private R2 snapshot → disposable cloud
browser**. The exporter reads the exact owner-selected Aside cookie database,
read-only, after narrow Keychain authorization. It does not discover profiles or
copy the whole profile. The dedicated compiled, ad-hoc-signed Swift helper accesses
only `Aside Safe Storage` / `Aside` through the Security framework. Only explicit
`authorize` may prompt. Background export disallows UI and fails closed when the
item is locked or unauthorized. No automatic ACL change or broad interpreter trust
is an authorization mechanism.

The supported format is Chromium cookie schema 24 with encrypted `v10` AES-CBC
cookies and validated embedded domain hashes. Exact policies select raw `host_key`
and name lists without widening leading-dot scope. Requested domain policies select
only cookies whose exact cookie domain belongs to the approved registrable domain
or its subdomains, never parent suffixes or sibling tenants. The pinned Swift PSL
and `tldts` private-suffix rules must stay aligned; a mismatch fails closed.
The helper preserves domain, path, expiry, Secure, HttpOnly, and SameSite None/Lax/Strict;
unspecified SameSite remains omitted. Microsecond timestamps use safe integer
arithmetic before conversion; expired cookies are omitted and session cookies
retain session expiry. Empty selected authentication is an ordinary empty snapshot,
not a login detector. Unsupported schemas/encryption, partitioned cookies,
localStorage, IndexedDB, and other profile/password-manager state are not exported.
Do not flatten partitioning or silently widen the site policy to work around a gap.

The helper encrypts before stdout: fresh AES-256-GCM key, 12-byte nonce, 16-byte
tag, RSA-OAEP-SHA256 key wrapping, and authenticated ordered metadata through
`browserEnvelopeAad`. R2 stores ciphertext only. The private decryption key stays
in browser-specific coordinator state; it is not sent to the runner or model.
Trusted coordinator code validates and decrypts briefly for import; only the
selected authentication reaches the browser context. CLI/status output contains
metadata, not cookie values, page observations, or screenshots. The separate
browser-sync token can read policies/public encryption keys and upload encrypted
snapshots, not approve tasks or use general control/executor privileges.

Requested-only export is selected by `config-create --requested-sites`. Fresh
version-bound task approval records a durable per-site snapshot request; proposals,
model generation, and website content do not. A domain policy change revokes its
old request and requires fresh approval. Per-site authority, policy version, and
digest are rechecked by the exporter before invoking the helper. The coordinator
rechecks current requested authority before accepting upload and again at commit.
All-site eligibility is never permission to export a full cookie jar.
The separate `--approved-sites` mode uses an explicit private array of locally
reviewed policies rather than the requested-site feed.

`watch` polls for requests approximately once per minute. Private `refresh.sqlite`
persists the request cursor, policies, and per-site attempt/success schedule.
Approximately six-hour attempt fences survive failures, interrupted attempts,
policy updates, and restarts. It never prompts, detects login, or performs login
recovery. Explicit `sync` is a separate one-shot attempt. Default snapshot expiry
and maximum admitted capture span are 30 days; selection and approval reject older
or unavailable snapshots. Pruning retains the latest two unexpired versions per
site plus versions pinned by reviewed/active/uncertain work. A task uses its
approved versions throughout; later refreshes affect later tasks only.

Disabling eligibility or revoking a native grant prevents new eligibility/claims,
not physical stop or erasure of accepted work. Policy replacement revokes the
requested capture authority; cached exporter state alone cannot authorize export.
Revocation does not recall imported cookies, roll back website effects, or prove
immediate ciphertext deletion. The cleanup fences and limits below still apply.

An immutable ciphertext-candidate ledger precedes each R2 PUT. A confirmed replay
returns metadata without another PUT; changed, interrupted, quarantined or deleting
identities cannot be resent or selected. Commit and deletion recheck policy, expiry,
and active/continuation leases in a SQL transaction. R2 and SQLite are not one atomic
transaction: a lost receipt or late provider write remains uncertain even after DELETE.
Those candidates stay fenced and are periodically re-deleted; cleanup does not promise
that a provider can never materialize the old object later.

Durable alarms drive ciphertext-only housekeeping independently of the model, browser,
Mac availability, and new uploads. Successful and failed admitted uploads both
schedule cleanup; a lost first receipt does not require another Mac refresh.
A batch makes at most 16 DELETE attempts, retries on a 15-minute cadence,
and schedules short continuations when more work remains.
The live uncommitted/quarantined admission cap is 64; historical successful exports
and deletion tombstones do not consume it. Reaching that cap fails closed and needs
operator investigation. Expired committed versions can still drain at the cap.

### Cloud Browser Run lane

Browser Run is the selected provider, not Cloudflare Containers. The runner uses
the trusted `BROWSER` binding, with recording disabled and dedicated contexts per
site. Restricted policies also use provider domain guardrails. Public-resource
policies omit that provider allowlist so public HTTPS dependencies can load;
fixed page-request code enforces the public-host checks instead. It blocks
unsupported network paths, WebSocket, and service-worker use. Neither mode claims
DNS pinning. Only the selected site's cookies are imported. Context state can
change during the task, then is discarded. No destination cookies, storage, or
profile changes return to the Mac.

The RPC-only `BrowserWorker` Durable Object retains immutable run ownership,
admission receipts, deadlines, and stop fences. Its public fetch surface is 404.
A reconstructed actor can inspect/close its persisted session, not replay work or
reimport authentication. The provider adapter issues a session-targeted destruction
request through the trusted binding. A `closing`/`closed` response is not stop:
presence checks must observe that exact session absent within one ten-second
transport budget. Timeout, malformed responses, or transport failure retain
uncertainty. Disconnect alone is not destruction. Hard deadlines, idle handling,
and coordinator cancellation bound lifetime.

Separate conversations, objects, and code paths are not capability isolation.
`BrowserWorker` is in the same Worker deployment and shares its environment; do
not claim that its bindings are security-isolated from model, vault, or account
state. Website authentication can also rotate or invalidate server-side despite
no filesystem write-back. Signed-out pages are ordinary blocked/needs-input task
outcomes, not empty carts or inboxes. There is no bespoke login-state detector,
reauthentication, login retry loop, or session-expiry notification subsystem.

### Protected HTTP surface

All routes are exact method/path matches. Control, executor, and browser-sync
tokens are distinct; none is a device or model credential. Cookies and private
decryption keys have no public read route.

| Method and path | Role | Contract |
| --- | --- | --- |
| `GET /api/browser` | Control | Metadata status and bounded task projections |
| `GET /api/browser/settings` | Control | `{version, allSites}`; eligibility defaults false |
| `PUT /api/browser/settings` | Control | `{expectedVersion, allSites}`; stale owner settings fail |
| `GET /api/browser/sites` | Control or browser-sync | Current approved policies and digests |
| `PUT /api/browser/sites/:id` | Control | `{expectedVersion, policy}`; current version, or zero for new registration |
| `GET /api/browser/snapshots` | Control | Immutable capture metadata, not ciphertext or cookies |
| `GET /api/browser/snapshot-key` | Browser-sync | Public RSA key and key ID only |
| `GET /api/browser/snapshot-requests?after=N` | Browser-sync | Approved capture policies and digests; nonnegative cursor, at most 16 sites, durable cursor order |
| `GET /api/browser/snapshot-requests/:id` | Browser-sync | Current approved per-site capture authority; absent/replaced requests fail closed |
| `POST /api/browser/snapshots/:id` | Browser-sync | Raw encrypted JSON, exact Content-Length, no Content-Encoding |
| `GET /api/browser/tasks` or `/tasks/:id` | Control | Retained task state, goal, versions, and actual result |
| `POST /api/browser/tasks` | Control | `{taskId, prompt, sites, timeoutMs}`; `{siteId, startUrl}` or, with all-site eligibility, `{startUrl}`; proposal, never approval |
| `GET /api/browser/tasks/:id/runs` | Control | Bounded owned run history |
| `POST /api/browser/tasks/:id/approve`, `/cancel`, `/correct`, `/cloud`, or `/reconcile` | Control | `expectedVersion`; correction adds `text`, cloud adds `snapshotIds`, reconciliation requires `confirmStopped: true` |
| `POST /api/executor/browser/poll` or `/report` | Executor | Exact owner/assignment/operation receipts; `stopped` and `uncertain` are separate facts |

### Evidence and remaining authorization

[Integration evidence](../learning/assistant-core-verification.md#browser-integration-verification)
owns the isolated and hosted results. Bounded scenarios exercised real model turns
on both lanes, requested-site encrypted export/R2 import, native original-tab close,
and hosted session destruction/absence. An initial cloud shutdown remained uncertain
until actual stop and explicit reconciliation; replacement work did not replay it.

The anonymized [portability matrix](../learning/browser-session-portability.md#anonymized-result-matrix)
is narrower than general workflow coverage. One infrastructure-dashboard result was
confounded by a signed-out source and remains unresolved. Earlier experiments used
ordinary Chromium/Playwright, not transferred Aside memory, skills, or agent behavior.
Six-hour wall-clock refresh/ageing, arbitrary-site authentication, playback,
Containers, and visual Telegram browser controls remain unverified. Native
unknown-popup/lost-REPL recovery still requires actual target absence and owner
reconciliation. New credential scopes, account actions, paid resources, or installed
service changes require separate authorization.

### Source and primary references

- [Protocol and limits](../../src/shared/browser.ts), [task ownership](../../src/worker/browser-store.ts), [model tools](../../src/worker/browser-tools.ts), [Telegram controls](../../src/worker/browser-telegram.ts)
- [Native adapter](../../src/mac/browser-aside.ts), [exporter](../../src/mac/browser-export.ts), [helper](../../src/browser/aside-cookie-export.swift)
- [Snapshot storage](../../src/worker/browser-snapshots.ts), [cloud runner](../../src/worker/browser-cloud-run.ts), [provider adapter](../../src/worker/browser-cloud.ts)
- [Aside developer interfaces](https://docs.aside.com/help/developers), [Aside pricing](https://aside.com/pricing), [Playwright authentication](https://playwright.dev/docs/auth)
- [Browser Run session destruction](https://developers.cloudflare.com/browser-run/cdp/session-management/), [binding API](https://developers.cloudflare.com/browser-run/reference/browser-binding-api/)

## History

- 2026-10-10: Site-scoped, OS-authorized experiments established selected local/cloud read-only account access. One target remained ambiguous after the source session was lost.
- 2026-10-11: Accepted approximately six-hour one-way refresh and ordinary signed-out handling, without write-back or a login-management system.
- 2026-10-13: Implemented native owned-tab tasks, bounded Browser Run execution, compiled encrypted export, fixed-version approval, and durable stop/uncertainty fences.
- 2026-10-14: Replaced installation rollout chronology and named account targets with reusable public behavior and anonymized evidence.
