---
title: Persistent Pi core with version-bound Mac execution
aliases: [core runtime selection, direct ChatGPT OAuth, durable assistant implementation]
updated: 2026-10-14
status: accepted and implemented
---

# Persistent Pi core with version-bound Mac execution

## Context

The assistant must provide natural interaction and useful actions, not only a new hosting location. Earlier assistant trials were slow to act, handled scheduling intent poorly, and left voice conversations silent during background work. The accepted [placement policy](2026-10-10-execution-placement.md) prefers the Mac and reserves cloud execution for explicitly authorized needs.

A cloud coordinator still needs application-owned permissions, messaging, reminders, result delivery, and uncertain-outcome handling. Moving the entire coding harness into an always-running container would not meet the intended boundary.

## Decision

Use one owner-scoped Durable Object with the pinned Cloudflare PiHarness/Pi Durable integration. Pi owns agent state and generation; the Agents lifecycle queue supplies durable wakeups. Keep operational records and replay receipts in application SQLite tables rather than introducing a second model orchestration system.

Implement authenticated Telegram text ingress, a separate local control conversation, durable text reminders, and an outbound Mac executor. Every new or edited shell command requires explicit approval of its displayed version. Preserve job ownership through disconnects. Do not use lease expiry to authorize another execution of uncertain work.

Use independent direct ChatGPT OAuth through the `openai` provider by default. Disable API-key fallback. Keep the legacy provider separate rather than relabelling existing subscription credentials. Keep credentials and local Worker state private, and make synchronization an explicit ownership handoff.

Local verification must not deploy, upload credentials, or change installed external services. Native alarms, calls, browser integration, subagent tools, and urgent cloud execution require their own implementation and authorization boundaries.

## Consequences

- Ordinary conversation can proceed while an approved Mac command runs. Durable completion generates a later model turn.
- Reminder and command corrections preserve identity and use optimistic versions. Old approval messages cannot authorize edited commands.
- The Mac does not need a public inbound endpoint. It does need an active outbound daemon, and polling consumes requests.
- Native commands are not sandboxed. Approval remains a real security boundary.
- A crashed execution is reported as uncertain and pauses new work until owner reconciliation. Telegram sends with ambiguous outcomes are not blindly duplicated.
- The direct model route works in local workerd. Hosted provider access and Telegram delivery still require deployed verification; local success is not that evidence.
- The durable system has one active credential-refresh owner. Cloned refresh tokens are not a safe multi-runtime synchronization design.

The current contracts live in [assistant runtime](../subsystems/assistant-runtime.md), [Mac executor](../subsystems/mac-executor.md), and [model authentication](../subsystems/model-auth.md), not in this decision record.

## Evidence

- The installed Pi AI 1.1.0 catalogs and public OAuth interfaces provide the selected direct and legacy subscription providers. The implementation uses their actual provider factories.
- [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) and [Cloudflare PiHarness](https://developers.cloudflare.com/agents/harnesses/pi/) provide the hosted runtime basis. The exact version set is pinned in the repository.
- [Local core verification](../learning/assistant-core-verification.md) records real model/tool turns, command approval and execution, natural-language correction/cancellation, restart recovery, and remaining limits.
- [Telegram webhooks](https://core.telegram.org/bots/api#setwebhook) provide the stateless ingress interface; isolated verification does not change live bot routing.
