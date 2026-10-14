---
title: Verify browser integration and session portability
aliases: [browser snapshot verification, disposable browser probe, native browser verification]
updated: 2026-10-14
---

# Verify browser integration and session portability

## Current

### Scope and prerequisites

Use isolated synthetic state first. The implemented native/export/Browser Run
contract is in [browser access](../subsystems/browser-access.md); executable setup,
grants, helper authorization, refresh, and recovery are in
[development and operation](local-development.md#operate-browser-tasks). Do not
copy that operating specification into a probe. Standard repository checks are
in [Checks](local-development.md#checks). Use Node 24 or later and record actual
Mac, Aside, helper, Chromium/Playwright, and provider versions privately.

Live Keychain access, installed Mac grants/configuration changes, credential
export/upload, account mutation, deployment, paid resources, and hosted provider
verification need separate explicit authorization. Historical authorization does
not cover another probe. Never clone hosted model credentials into an isolated
coordinator. Containers remain untested and are not the selected browser backend.
A same-Worker DO binding is not capability isolation.

The old portability scripts and disposable Worker were removed. Current helper/
CLI/native/cloud implementations exist. Isolated checks alone do not establish
production Keychain trust or hosted Browser Run semantics; the
[integration evidence](../learning/assistant-core-verification.md#browser-integration-verification)
records separately authorized hosted results and remaining limits. Read
[portability evidence](../learning/browser-session-portability.md) for the
anonymized result matrix, source-identity criteria, and signed-out-source ambiguity.
Keep new probes, generated configs, state, screenshots, and logs outside the repository,
with directories `0700` and private files `0600`.

### 1. Verify without live website credentials

1. Select an isolated coordinator/config/journal and bounded loopback fixture.
   Use independent control/executor/sync tokens. Native grants start disabled.
   Test restricted policies separately from explicit public-site eligibility:
   neither mode approves a task or exports a proposal. Keep fixtures and outputs
   private; HTTP loopback is not eligible for all-site mode.
2. Build both production and synthetic-only helpers without authorizing the live
   item. A synthetic build cannot read Aside's Keychain item. Set `PRIVATE` to a
   canonical private directory and choose new filenames:

   ```sh
   npm run browser -- helper-build --output "$PRIVATE/aside-cookie-export"
   npm run browser -- helper-build --synthetic-fixture \
     --output "$PRIVATE/synthetic-cookie-export"
   printf '%s' "$PRIVATE/synthetic-cookies.sqlite" | \
     "$PRIVATE/synthetic-cookie-export" fixture-create
   ```

   `fixture-create` creates only its named synthetic Keychain item and new SQLite
   database. It refuses existing state. A collision is not permission to delete
   someone else's fixture. Use only this database/helper in synthetic export
   config; never substitute the live cookie path. After the fixture's owned use:

   ```sh
   "$PRIVATE/synthetic-cookie-export" fixture-delete
   ```

3. Exercise export against the real compiled helper and an isolated coordinator's
   public encryption key. Verify exact host/name selection and approved registrable
   domains, including private PSL tenant boundaries. Parent, sibling, bare-suffix,
   special-use, and unapproved domains must fail closed. Check expired/session
   cookie handling, timestamp precision, preserved attributes, and omitted
   unspecified SameSite. Confirm plaintext does not appear on helper stdout or
   CLI output. Independently decrypt the envelope in private test memory and
   verify RSA-OAEP, GCM metadata authentication, and rejection of changed metadata/
   domain hashes, unsupported partitioning, schema, and encryption. Do not weaken
   live trust to make a fixture pass.
4. Verify the distinct sync role: key/approved-request read and encrypted upload
   work; general control/task approval/executor access fail. A proposal must not
   export; approval enrols only its site scope. Withdrawn authority must be checked
   before the helper and again at coordinator upload/commit. Confirm receipt
   digest/length, immutable snapshot identity, wrong-policy refusal, fixed-version
   cloud approval, and independent durable refresh attempts after error/restart.
   Exercise actual one-minute watch discovery. An isolated attempt is not evidence
   of six hours of unattended production operation.
5. Drive an actual fresh Chromium browser with synthetic authentication and
   isolated loopback pages. Exercise actual observe/refs, navigation, fill, click,
   contenteditable, native Enter, and PNG. Check stale refs, changed/focus-mutated
   credential controls, password/file controls, external origins, oversized trees/
   images, forbidden requests, and WebSocket refusal. Inspect real page effects;
   mock receipts and tests that echo source text are not browser evidence.
6. Cancel and expire runs; observe actual browser/context disappearance. Restart
   the isolated coordinator/runner and check retained operation identity, admission
   before dispatch, replayed receipts, changed-argument rejection, and uncertain
   dispatch without replay. An empty response or disconnected client is not stop.

### 2. Verify the actual native Aside lane

Use only separately approved loopback synthetic pages and task-owned tabs. Keep
live website credentials, user tabs, and installed services/configuration out of
scope. Grant the fixture's exact policy in the isolated Mac configuration, then
review and approve its bounded task through the real coordinator.

Include an end-to-end case using the actual Mac CLI subprocess with its private
`--config`/state, real authenticated HTTP routes, wrong-role refusal, version-bound
approval, and registered browser tools. Verify exactly one intended synthetic
fixture mutation and actual observation evidence; task completion must follow
owned-tab disappearance. Direct tool execution proves integration, not a live LLM
round. Keep live-model verification separately authorized and separately reported.

1. Confirm the owned blank marker's `targetId` matches `listBrowserTabs`. Observe
   the real page; exercise fill/click/press/screenshot and verify fixture effects.
   Refuse password controls, external-origin actions, and stale refs. Check model
   tools do not expose arbitrary REPL/MCP, storage, or credential access.
2. Close a popup-free task through its original owning REPL and confirm each
   recorded owned target disappeared while pre-existing user tabs stayed intact.
   Closing/detaching an MCP connection is not this check.
3. Deliberately lose a bounded start/primitive connection. Check that the task
   retains its owner and browser recovery pause, reports uncertainty, and does
   not duplicate the task in cloud or replay the primitive.
4. Check popup/lost-watcher refusal without assuming descendant ownership. Aside's
   popup metadata lacks a target ID. Borrowed attachment cannot prove closure:
   `closeTab` detaches it, and ordinary navigated pages did not accept `window.close`
   as a general stop mechanism. Review actual owned targets/descendants and their
   effects privately, explicitly close only known owned tabs, then follow
   [recovery](local-development.md#recover-an-interrupted-mac). Do not report cleanup
   until absence is observed and retained stop/reconciliation is acknowledged.
5. Distinguish the action-origin fence from network isolation. Native tabs use the
   existing profile and can cause page/server effects; they are not a sandbox.

### 3. Verify hosted Browser Run only after separate authorization

Provision only the approved browser/R2 resources and bounded isolated installation.
Review costs, lifetime, secrets, cleanup owner, and resource removal before launch.
Do not modify the production installation or upload real account authentication
just to prove the provider adapter.

Verify actual trusted-binding launch, session identity/listing, selected per-site
context import, an explicit no-saved-session run, exact/public resource policies,
forbidden network paths, operation receipts, deadline/idle expiry, disconnect/
reconstruction fences, and provider destruction with observed owned-session
absence. Do not close unrelated sessions. Confirm the RPC-only runner has no public
proxy and recording is disabled. Exercise stale owner-bound `/browse` cards and
real message confirmation separately; source or local tests do not verify Telegram
presentation. Record local Chromium and hosted results independently. A successful
dry-run build or historical disposable cloud probe does not verify the integrated
provider's launch/connect/close semantics.

### 4. Optional authorized live-site portability probe

This is a read-only, site-specific experiment, not a login-management feature.
Before touching state, name the approved site/account privately, protected view,
exact cookie policy or approved registrable-domain scope, destination, deadline,
cost boundary, and cleanup owner. All-site eligibility is not approval for an
unrequested account-access experiment.
Exclude purchases, messages, cart/watchlist/profile changes, subscriptions,
playback, token creation, DNS, deployments, and billing unless separately
authorized. Do not upgrade Aside, enable paid features, or change unrelated
installed assistant, browser, or calling configuration.

1. Establish a currently signed-in source and a private account-identity marker.
   Compare in memory or with a protected hash and report only match booleans.
   A public homepage, profile link, anonymous bootstrap HTTP 200, or empty list
   is not authentication evidence. Account hydration and regional routes matter.
   Stop if the source is signed out; do not log in or bypass a challenge.
2. Review storage dependencies without blanket-exporting the whole profile or
   multi-account sessions. Schema 24/`v10` support is a pinned implementation,
   not a promise for later installed browser formats. Unsupported localStorage,
   IndexedDB, or partitioning is a gap, not permission to widen export.
3. Use the dedicated compiled helper and reviewed exact policy, read-only source,
   narrow explicit Keychain authorization, and private encrypted output. Never
   use broad permanent interpreter/security trust. Manual approval alone does
   not establish unattended access. Sample after authorization and preserve the
   original encrypted snapshot's integrity; never modify the source profile.
4. Use fresh browser processes/contexts per case. Start a clean control without
   imported state and confirm the protected view lacks the expected identity.
   Import only the selected original state, check actual hydrated identity and
   protected view, then recheck the source immediately afterward. Recheck the
   source before each import. A signed-out source makes failure ambiguous, as
   in the original Dashboard case; it is not proof of universal non-portability.
5. Close the destination and repeat in another fresh browser using the **same
   original snapshot**, never destination state. Confirm unchanged snapshot
   integrity and source validity. Keep request policy narrow and read-only;
   dynamic pages may need reviewed authentication refresh, not unrestricted
   mutations. A login wall is not an empty cart/inbox.
6. Record Mac, Linux, and hosted outcomes independently. Local Linux success is
   not cloud acceptance. If separately authorized, establish actual browser
   egress/region via an approved trace endpoint; do not retain a user's local IP.
   Record provider-added headers and versions as conditions, not an IP-only test.
   Immediate repeat imports do not prove snapshot ageing or six-hour refresh.

### 5. Prove cleanup and report bounded findings

Close each owned tab/context/session and observe absence, including provider
listing where applicable. Stop owned fixture processes/watchers and remove only
owned disposable resources. Never write destination state back to the Mac. Remove
synthetic Keychain fixtures, snapshots, tokens, private logs/screenshots, scripts,
and temporary workspaces after evidence is recorded; keep persistent operational
journals until uncertainty is reconciled. Do not stop unrelated Docker/user work
or close unknown tabs. No filesystem write-back does not rule out server-side
session rotation/invalidation.

Report versions, exact tested behavior, identity/clean/repeated-import booleans,
source-validity checks, snapshot integrity, and actual stop/cleanup status. Keep
credentials, deployment URLs, account identifiers, and page transcripts out of
maintained docs. A retained `stopped: false, uncertain: true` is truthful uncertainty,
not a cleanup pass. Failed cleanup must remain explicit until observed resolution.
Update the relevant learning record only with actual authorized results; preserve
unverified hosted semantics, unattended trust, ageing, Containers, playback, and
untested sites as limits. Success is not rollout authorization.

## History

- 2026-10-10: Clean controls, repeated original-state imports, hydration/identity checks, and before/after source checks bounded anonymized portability findings.
- 2026-10-13: Added implemented-helper, actual native/Chromium, ownership/stop, synthetic-first, and separately authorized hosted-provider verification.
- 2026-10-14: Removed named service and external-installation history while preserving repeatable verification controls.
