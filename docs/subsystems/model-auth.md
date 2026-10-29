---
title: Subscription-backed model authentication
aliases: [Claude subscription OAuth, ChatGPT OAuth, model credentials, OpenAI sign-in]
updated: 2026-10-19
---

# Subscription-backed model authentication

## Current

### Supported providers

`src/model/` uses the pinned Pi AI provider implementations. The default is `anthropic` with `claude-opus-5-5`. It uses Pi's built-in **Claude Pro/Max** OAuth flow and its direct Anthropic Messages transport. Pi sends Claude Code identity headers and system identity on this route. No Claude Code process, Agent SDK, or container is involved, so the coordinator keeps running inside the Worker. `openai` with `gpt-5.6-sol` (**Sign in with ChatGPT**) and the legacy `openai-codex` route remain supported alternatives.

These credentials are not interchangeable. An Anthropic credential must be an OAuth access token with the `sk-ant-oat` prefix. Pi treats any other Anthropic token as an API key, which bills Console API credits instead of plan limits. Umpi therefore rejects other tokens at sync time, at request authorization time, and after every refresh. Direct OpenAI OAuth requires the issued client ID and `chatgpt.tokens.use.direct` scope. A token from another provider or harness must not be relabelled as a different provider's credential. Canonical parsing strips caller-supplied request headers and endpoint overrides.

API-key authentication is disabled on every registered provider. Ambient `ANTHROPIC_*` and `OPENAI_*` variables are never used.

#### Limit-only API-key fallback

The one exception is an optional Anthropic API key in the `UMPI_ANTHROPIC_FALLBACK_KEY` Worker secret, used only while the Claude subscription is at its limit:

- The Anthropic provider watches each subscription request. A response classified as a rate or usage limit (HTTP 429) starts a 30-minute fallback window. Pi retries a 429 after a few seconds, and that retry, in the same turn, is authorized with the key. After the window, requests use the subscription again.
- Without a valid `sk-ant-api…` key, a limit is only recorded and requests fail visibly, as before.
- `model.fallback` in `GET /api/status` shows whether a key is configured (and in `keyIssue`, why a set secret is not a usable API key; surrounding whitespace is ignored), whether the window is active and until when, the last limit, and requests billed to the key today. The key itself is never stored in SQLite or shown.
- The first switch on a local day sends one Telegram notice saying API credits are in use and until when.
- API credits are billed. Set a spend limit on the key's Console workspace. Keep Claude extra usage disabled unless paid overage is deliberately wanted. Commands launched on the Mac use their own application settings; this coordinator policy does not rewrite those settings.

The owner conversation and inherited subagents use high effort. Background reviews (mail, brief, daily preparation, commitments) use medium effort. Coding and browser runs set medium effort themselves.

The Claude route completed real model and tool turns locally and on the hosted Cloudflare coordinator. Its responses carried Claude plan quota headers rather than API billing; see [verification evidence](../learning/assistant-core-verification.md#model-provider-verification). The direct OpenAI flow was verified earlier in the same way. The same valid legacy Codex token worked through Pi on Node but received HTTP 403 through local workerd; the transport-level cause was not established. Success on one route is not proof that every subscription transport works from every Cloudflare egress path.

### Voice-note transcription

Telegram transcription uses a separate Umpi `openai-codex` subscription OAuth grant at `https://api.openai.com/v1/audio/transcriptions`, with `gpt-4o-mini-transcribe`. The real hosted audio smoke accepted that grant; the separate direct reasoning grant was rejected at this route. This is observed OAuth compatibility, not a guarantee for every account, future token scope, or billing policy. The primary reasoning provider is configured separately, so the Claude switch keeps this grant for transcription.

The coordinator resolves fresh OAuth under its credential lock and remains the sole refresh owner. Apart from the limit-only fallback key, no external refresh credential, API key, runner, Workers AI binding, or additional subscription is used. Input/recovery limits belong to the [Telegram contract](assistant-runtime.md#telegram); [operation](../runbooks/local-development.md#operate-telegram-voice-notes) owns independent login and handoff; [voice verification](../learning/assistant-core-verification.md#telegram-voice-note-verification) records the distinct backend-route findings.

### Independent storage and explicit handoff

Interactive login writes only to `~/.config/umpi/auth`. Directories are owner-only and credential files have mode 0600. The store refuses repository-local, symlinked, shared, corrupt, or unsupported credential state. It does not import or alter credentials from another application.

The local store serializes the full asynchronous read-modify-write, including OAuth refresh, across processes. Writes are atomic and synchronized. Cancellation after a token has rotated does not discard the new credential. A killed writer's lock is not silently stolen; inspect its recorded owner before removing a stale lock.

Login and synchronization are separate operations. `auth sync` explicitly sends one canonical credential to the coordinator's protected `/api/auth` endpoint. It requires HTTPS except for exact loopback, rejects ambiguous origins, follows no redirects, and neither refreshes the token nor retries the upload.

After handoff, the active coordinator owns refresh. Its credential operations are serialized within the single Durable Object and stored in its SQLite database. The CLI's local copy does not automatically receive later rotations. Do not operate several independent refresh owners from cloned credentials or overwrite a newer coordinator credential with an old local copy. For a replacement login, complete a new independent login before an explicit sync. Moving an active installation requires a deliberate credential-ownership handoff.

After handoff, an active hosted coordinator can be the sole refresh owner and local copies can be retired. In that state, an empty `npm run auth -- status` is expected; inspect protected hosted status for the active login. Do not copy a credential back from an old local database or run local and hosted coordinators from a cloned refresh token.

### Local and hosted security

`npm run dev` places local Worker state and logs under `~/.config/umpi/worker`, outside the repository, with owner-only access. That state can contain refresh credentials and private transcripts. Preserve it across restarts and do not commit or share it. Hosted Durable Object storage is part of the credential trust boundary for a hosted installation.

Status endpoints expose credential presence/type, not token contents. After a failed model turn, `model.issue` and `model.lastFailure` give the cause from the provider's own error text: `limit`, `overloaded`, `auth`, `network`, `context`, or `other`, with credentials removed. `model.configured` is not a provider connectivity test. An access-only credential within five minutes of expiry is refused for new work. It is useful for bounded diagnostics but is not a durable login strategy. Runtime initialization statically registers the SDK's public OAuth flow loaders so bundled Workers do not depend on opaque dynamic imports.

### Operation

The [development and operation runbook](../runbooks/local-development.md) owns login, sync, startup, and hosted maintenance. Do not place credentials in command arguments, chat messages, source code, screenshots, or test fixtures.

## History

- 2026-10-11: Added independent ChatGPT login, private stores, explicit credential sync, and OAuth-only provider selection.
- 2026-10-11: Added explicit refresh-ownership handoff for hosted Durable Object operation.
- 2026-10-13: Verified hosted subscription transcription with a separate Codex OAuth grant while preserving direct reasoning and the no-API-key policy.
- 2026-10-14: Changed Umpi's primary model selection to `openai/gpt-5.6-sol`; voice transcription remains a separate `openai-codex` grant and model.
- 2026-10-19: Changed Umpi's primary model selection to `anthropic/claude-opus-5-5` through Claude subscription OAuth, with `sk-ant-oat` enforcement and high main-conversation effort. Voice transcription keeps its `openai-codex` grant.
- 2026-10-22: Added failure causes from the provider error text and the limit-only Anthropic API-key fallback after subscription usage limits stopped scheduled work.
