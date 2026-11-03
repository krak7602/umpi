---
title: Read T3 Code threads through T3 Connect, not through the Mac executor
aliases: [T3 Code integration decision, T3 Connect MCP access, coding-thread visibility]
updated: 2026-11-03
status: accepted and amended the same day; see assistant runtime for the current contract
---

## Context

The owner runs coding agents in T3 Code on more than one machine. One of them is a work machine. Umpi needed to know which threads exist, what they are doing, and what waits on the owner, from the app's Work tab and in conversation.

Two routes were possible. The Mac executor could run on each machine and read T3 Code locally. Or Umpi could call each machine's T3 Code MCP server through T3 Connect, T3 Code's hosted relay, as a remote MCP client.

The owner did not want to install or run Umpi software on the work machine, and setting up the executor on several machines is extra work. T3 Code's MCP server already offers thread, project, and environment tools, OAuth with dynamic client registration and PKCE, approval with a pairing code on the machine, and access levels from read only to full access.

## Decision

Umpi is a remote MCP client of each machine's T3 Code, reached through its T3 Connect address. Nothing of Umpi runs on the machine. The owner adds a machine by its MCP address in the app, then approves Umpi on the machine's approval page with a pairing code and chooses the access level.

Start with read access: list, search, and read threads and projects. Starting or messaging threads is a later step that needs its own owner approval design.

T3 Code issues no refresh token; access lasts about 30 days. Umpi does not try to extend it. The app shows when access ends and asks the owner to approve again.

## Consequences

- Machines that are asleep or offline do not answer; Umpi reports that instead of guessing.
- The approval return address is a public route on Umpi's own origin, protected by a one-time state that expires after 15 minutes.
- The machine's T3 Code access level, not Umpi, is the final limit on what Umpi can do there.

## Amendment: reach Tailscale addresses through an on-demand bridge

The owner reaches T3 Code through Tailscale HTTPS (`tailscale serve`), not T3 Connect. T3 Connect's relay service is not published, so it cannot be self-hosted. Cloudflare Workers cannot join a tailnet, and Cloudflare Mesh would need Cloudflare's client on every machine, including the work machine.

Umpi therefore runs one container that joins the tailnet only while Umpi needs a machine. It uses a Tailscale OAuth client secret that can create only ephemeral `tag:umpi` devices, and the tailnet policy limits that tag to HTTPS on the T3 machines. Nothing is installed or changed on the machines. T3 Connect addresses still work directly.

## Amendment: Umpi manages threads, and asks first only for its own ideas

The owner wants Umpi to manage sessions, not only read them: message, start, stop, and answer agents. The owner chose the approval rule: when the owner asked, Umpi acts; when Umpi decided on its own, it asks first with Approve and Decline buttons. Machines are approved at Full access, so the machine's level allows this; Umpi's own rule decides when it asks.

## Amendment: cloud machines, one per session

One machine limits parallel work; the owner wants many sessions at once. Umpi therefore starts a container per session, each with T3 Code and the Pi agent, and treats each as a T3 Code machine. Decisions the owner made:

- **No separate model login.** Many machines each signing in would strain the subscription, so Pi in every container uses Umpi's Claude login through a model gateway. The credential stays in Umpi, which alone refreshes it.
- **No grace period.** A machine is saved and stopped as soon as nothing is working; keeping it up for a while costs money for little use. A reply or a Wake starts it again from its saved state.
- **One SSH key for all machines**, generated for this purpose and kept out of the owner's own `~/.ssh`, and a commit identity per organization, both in private secrets.
- **Umpi stays the higher level.** Deeper work belongs in T3 Code; Umpi starts, wakes, watches, and messages sessions.

T3 Code grants full access only through its OAuth approval, so each machine approves Umpi over loopback with a pairing code it mints itself.

The current contracts live in [T3 Code threads](../subsystems/assistant-runtime.md#t3-code-threads) and [cloud machines](../subsystems/assistant-runtime.md#cloud-machines).
