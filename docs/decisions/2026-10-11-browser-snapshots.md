---
title: Use one-way browser snapshots and ordinary signed-out handling
aliases: [six-hour browser refresh decision, no browser session write-back]
updated: 2026-10-14
status: accepted; implementation and rollout status live in browser access
---

## Context

Signed-in website access is useful when an assistant needs an account-specific view. Local Aside can provide that access on the Mac, but the Mac can be unavailable during a cloud task. The design should not require Aside Pro as a prerequisite.

On 2026-10-10, authorized disposable experiments transferred selected Aside cookie state through normal macOS Keychain approval. Several anonymized account views passed local disposable Chromium and Cloudflare Browser Run checks. Clean signed-out controls and repeated fresh imports used unchanged original snapshots, with no cloud-to-Mac write-back.

This evidence was narrow. It did not establish snapshot ageing, unattended Keychain access, playback, arbitrary-site support, or a production exporter. One infrastructure-dashboard import failed while the source session was also signed out by the final check. That result did not establish a cloud-IP block or definitive non-portability.

Sessions can expire. Recognizing a signed-out page is ordinary agent behavior, not a reason to build a separate session-management system.

## Decision

Accept site-scoped, one-way authentication snapshots from the Mac to secure
storage and then to disposable cloud browsers. Keep local Aside as the primary
browser path when the Mac is available and capable. Do not merge destination
state into the Mac or write cloud cookies back.

Refresh approximately every six hours while the Mac is available. When it is
unavailable, use the latest available snapshot. This is an accepted design
cadence, not an implemented or tested schedule.

Treat signed-out state as a normal task outcome. The agent interprets the page
and tells the user when the task cannot proceed. Do not add a bespoke login-state
detector, login recovery system, automatic reauthentication, login-specific retry
loop, or special expiry notifications. Normal account awareness still applies:
a login page must not be reported as an empty cart, inbox, or order list.

The maintained operating specification is [browser access](../subsystems/browser-access.md).
It owns snapshot version selection, security requirements, disposal, and the
implementation boundary. This decision records why the policy was accepted,
not a second implementation specification.

## Consequences

- Offline-Mac tasks can attempt fresh service reads with the latest selected
  authentication state. A snapshot is not a cached copy of the website's data.
- Authentication can expire between refreshes or while the Mac is offline. The
  cadence makes no guarantee of continuous access, and no special repair system
  is required by this decision.
- Discarding cloud state avoids local profile merging. It cannot prevent
  server-side token rotation or invalidation of a shared login.
- At acceptance, scoped export, protected storage, cleanup, browser-version support,
  and unattended authorization still needed implementation. Interactive Keychain
  approval did not establish them; [browser access](../subsystems/browser-access.md)
  records the later implementation and remaining rollout boundary.
- The tested cloud browser is ordinary Chromium, not the Aside app or agent.
  This does not transfer Aside's memory, skills, password manager, or behavior.
- New uploads, probes, deployments, or changes to installed applications need separate authorization.
- Costs remain in [architecture](../architecture.md). This decision adds no second price table and does not approve an always-running cloud browser.

## Evidence

- [Browser session portability evidence](../learning/browser-session-portability.md):
  the anonymized mechanism, identity criteria, clean/repeated-import controls,
  cloud egress proof, unresolved signed-out-source result, and observed cleanup.
- [Browser session verification runbook](../runbooks/verify-browser-sessions.md):
  the authorization, source-validity, isolation, and cleanup requirements for
  any separately authorized disposable retest.
- Accepted operating policy: approximately six-hour refresh while the Mac is
  available; latest snapshot while offline; no write-back; signed-out outcomes
  handled through ordinary agent interpretation without special login recovery.
- [Aside privacy policy](https://aside.com/policy/privacy): browser sync does not
  establish a supported export contract.
- [Playwright cookie import contract](https://playwright.dev/docs/api/class-browsercontext#browser-context-add-cookies)
  and [Cloudflare Browser Run integration](https://developers.cloudflare.com/browser-run/playwright/):
  destination interfaces used by the experiment, not proof of universal website
  authentication portability.
