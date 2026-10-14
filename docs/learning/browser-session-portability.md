---
title: Browser session portability evidence
aliases: [Aside cookie export, browser authentication portability, session transfer experiment]
updated: 2026-10-14
---

# Browser session portability evidence

## Current

### Question and privacy boundary

Can a local Aside installation supply selected signed-in website state to a disposable Chromium browser without transferring the full profile or writing destination state back to the Mac?

An authorized 2026-10-10 experiment answered that question for several selected account views. The public record intentionally removes service names, account identities, profile markers, cookie names, cookie counts, local network details, and deployment identifiers. Those details are private account evidence, not project fixtures.

The experiment established bounded technical portability, not universal login support. One infrastructure-dashboard target did not restore authentication, but the source session was signed out by the final check. That result remains inconclusive.

The [current browser contract](../subsystems/browser-access.md) and [verification runbook](../runbooks/verify-browser-sessions.md) own maintained behavior and repeatable checks. This page preserves only the reusable evidence and limits.

### Export mechanism

Read-only inspection established these relevant facts:

- Aside used a Chromium cookie database with schema version 24.
- Selected values used Chromium's macOS `v10` encryption format.
- The browser-specific encryption key was available only through normal macOS Keychain authorization.
- Important authentication cookies could be HttpOnly, so page JavaScript was not a complete export interface.
- Chromium microsecond timestamps could exceed JavaScript's safe-integer range and required text/`BigInt` handling.

The probe opened SQLite read-only. It selected only explicitly approved registrable domains and cookie names, decrypted those selected values after normal Keychain approval, and verified each schema-24 embedded domain hash. It preserved domain, path, expiry, Secure, HttpOnly, SameSite, and supported partition attributes.

Unknown formats, failed domain-integrity checks, and unapproved scopes failed closed. No default-key fallback or authorization bypass was used.

Selected state lived in an owner-only temporary directory outside the repository. Directories used mode `0700` and files used mode `0600`. Cookie values, account markers, local IP addresses, and Keychain material were not logged or retained in public evidence.

This is an OS-level compatibility mechanism, not an official Aside export API. Browser, operating-system, database-schema, and encryption changes can break it.

### Controls

Each target used independent fresh browser processes:

1. A clean browser without imported state had to remain signed out.
2. A fresh browser imported the selected original snapshot and had to reach the approved protected view with the expected private identity marker.
3. Another fresh browser imported the same unchanged original snapshot and repeated the identity check.

Identity comparisons used protected hashes or in-memory comparisons. A public page, profile placeholder, HTTP 200, or empty list did not count as authentication.

The destination never seeded a later run. The original snapshot remained unchanged. Source validity was checked separately because a signed-out source makes a destination failure ambiguous.

### Anonymized result matrix

| Target class | Local disposable Chromium | Cloudflare Browser Run | Limit |
| --- | --- | --- | --- |
| Source-control account | Passed clean and repeated-import controls | Passed clean and repeated-import controls | Selected profile view only |
| Authenticated media account A | Passed | Passed | Account view, not playback |
| Authenticated media account B | Passed | Passed | Account view, not playback |
| Authenticated media account C | Passed | Passed | Account view, not playback |
| Authenticated media account D | Passed | Passed with a valid regional route | Account view, not purchase or playback |
| Infrastructure dashboard | Not restored | Not restored | Source later signed out, so the cause is unresolved |

The passing targets restored only the approved account views. Dynamic requests unrelated to the criterion could be blocked or fail. The results do not establish unrestricted APIs, DRM, playback, purchases, messages, account changes, or arbitrary navigation.

The cloud probe used Cloudflare Browser Run through a short-lived, authenticated Worker with recording disabled and no persistent browser storage. A provider trace confirmed remote Cloudflare egress without retaining the operator's local network identity. Browser versions and provider-added automation headers differed from local Chromium, so the result was not an IP-only comparison.

### Safety and cleanup

The authorized scope allowed read-only account views and authentication refresh needed for those views. It excluded purchases, rentals, subscriptions, profile changes, watchlist changes, messages, token creation, DNS changes, deployments, and billing changes.

Each target received only its own snapshot. The cloud control credential was not sent to target sites. The experiment did not upload a browser profile, Keychain item, password manager, Aside memory, Aside skills, or another target's state.

Cleanup confirmed:

- Provider browser-session listing returned no owned active session.
- The disposable Worker was removed.
- Local containers and temporary browser processes stopped.
- Plaintext snapshots, credentials, scripts, dependencies, and logs were removed from the private workspace.
- No paid Aside feature was enabled.

No runnable experiment probe or account snapshot is retained in this repository.

### Limits

- Results apply only to the tested account views, versions, headers, and networks.
- Cookie success does not establish arbitrary services, shopping, banking, passkeys, localStorage, IndexedDB, or device-bound credentials.
- Streaming-account authentication does not establish media playback.
- Immediate repeated imports do not establish usability after hours, token rotation, or a six-hour refresh interval.
- Manual Keychain approval does not establish safe unattended export.
- No filesystem write-back prevents profile merging, but cannot prevent server-side session rotation or invalidation.
- Ordinary Chromium is not the Aside application. Its agent, memory, skills, and password manager do not transfer with cookies.
- A signed-out outcome is ordinary and must be reported truthfully. It is not proof of a cloud-IP block.

### Primary references

- [Aside developer interfaces](https://docs.aside.com/help/developers)
- [Aside browser basics](https://docs.aside.com/help/browser-basics.md)
- [Aside agent permissions](https://docs.aside.com/help/security.md)
- [Aside privacy policy](https://aside.com/policy/privacy)
- [Playwright authentication state](https://playwright.dev/docs/auth)
- [Cloudflare Browser Run Playwright integration](https://developers.cloudflare.com/browser-run/playwright/)
- [Cloudflare Browser Run automatic identification headers](https://developers.cloudflare.com/browser-run/reference/automatic-request-headers/)

## History

- 2026-10-10: Selected account views passed clean and repeated imports in local disposable Chromium and Browser Run. An infrastructure-dashboard result remained inconclusive because the source session was later signed out.
- 2026-10-11: The [snapshot decision](../decisions/2026-10-11-browser-snapshots.md) accepted expiry as an ordinary task outcome without adding cloud-to-Mac write-back.
- 2026-10-14: Replaced service-specific account history with an anonymized evidence matrix before public release.
