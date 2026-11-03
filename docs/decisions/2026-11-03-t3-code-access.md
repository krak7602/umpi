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

The current contract lives in [T3 Code threads](../subsystems/assistant-runtime.md#t3-code-threads).
