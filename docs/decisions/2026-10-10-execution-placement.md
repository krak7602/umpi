---
title: Keep execution Mac-first with authorized cloud fallback
aliases: [execution placement, Mac-first dispatch]
updated: 2026-10-14
status: accepted
---

## Context

The assistant needs durable ownership and follow-through without discarding useful local tools. Mac-hosted services, local credentials, uncommitted data, and macOS-only capabilities do not move with a cloud coordinator.

The design avoids requiring another agent-platform subscription. Hosted Durable Objects and Containers require an appropriate Cloudflare plan, and cloud compute must not become an always-running home for the entire assistant. [Architecture](../architecture.md) owns runtime constraints and cost assumptions.

## Decision

Accept this execution-placement policy:

1. If the Mac is available and capable of the task, execute there.
2. If the Mac is unavailable and the task can wait, queue it.
3. If the Mac is unavailable and the work is urgent, offer cloud execution and obtain explicit authorization before running it.

Most coding stays on the Mac. Retain useful local harnesses; do not require Pi for every coding task. Cloud containers are disposable, on-demand executors. Ordinary conversation and API-only work should not require a container.

This decision accepts placement policy, not a completed migration. At the time it was accepted, Pi/Pi Durable was the preferred coordinator candidate, Telegram was a messaging recommendation, and the repository had no application implementation. Provider integration and subscription voice portability were not established by this decision. The later [persistent-core decision](2026-10-11-persistent-core.md) records the local implementation without claiming that cloud fallback or voice migration is complete.

## Consequences

A coordinator and an executor can be separate systems. Local capabilities remain available without requiring every task to use a cloud container or a new harness.

Waiting is a deliberate outcome when work can wait. Urgency is not blanket authorization for cloud execution. Linux still cannot perform Xcode/macOS work or obtain unpushed files from a sleeping Mac. Cloud authorization does not remove those capability limits.

Execution needs clear ownership. A lost Mac connection does not establish that its job stopped; reconcile the owner before dispatching the same work elsewhere. [Interaction quality](../concepts/interaction-quality.md#durable-follow-through-and-truthful-state) owns that requirement and truthful task-state reporting. Application code must also handle uncertain external effects, as described in the [runtime boundaries](../architecture.md#runtime-and-version-constraints).

Bound authorized cloud jobs, persist artifacts before shutdown, and do not hold a container for human input. Browser fallback has a separate interface and evidence boundary; use the [browser subsystem](../subsystems/browser-access.md), not an assumption that a Linux executor is the Aside app.

This decision does not authorize a deployment, credential upload, or change to any installed external application.

## Evidence

- Local credentials, uncommitted files, Xcode, and other macOS-only tools establish the need for a distinct native execution lane.
- [Pi](https://github.com/earendil-works/pi), [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), and [Cloudflare PiHarness](https://developers.cloudflare.com/agents/harnesses/pi/) provide the candidate runtime basis. Their capability and maturity limits are consolidated in [architecture](../architecture.md#runtime-and-version-constraints).
- [Cloudflare container pricing](https://developers.cloudflare.com/containers/platform/pricing/) and [Sandbox lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/) inform disposable execution. [Architecture cost assumptions](../architecture.md#cost-assumptions) preserve the illustrative figures and shared-allowance caveats.
- The [Telegram Bot API webhook interface](https://core.telegram.org/bots/api#setwebhook) supports the recommended messaging direction; it is not evidence of an installed Telegram integration.
