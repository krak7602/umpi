---
title: Intent, follow-through, and interaction quality
aliases: [interaction principles, voice retention criteria, assistant responsiveness]
updated: 2026-10-14
---

## Current

### Design evidence and success criteria

Earlier assistant trials felt less capable than direct coding and model harnesses. Simple requests and scheduling were slow or ineffective, and intent was not preserved consistently. These observations define the product problem; they are not a requirement to reproduce a particular prior installation.

Success means natural conversation with direct useful actions, few unnecessary clarification questions, corrections applied to existing work, and truthful automatic completion delivery. Infrastructure migration alone does not establish success. Compare interaction quality with the same model and reasoning configuration before attributing an improvement to the harness.

These are acceptance requirements, not a claim that every proposed capability is implemented. The [current runtime](../subsystems/assistant-runtime.md) supplies text, approved execution, and hosted proactive/daily-note follow-through. The native [phone companion](../subsystems/phone-companion.md) supplies structured actions and alarms only within exercised physical-phone scenarios. Coding and public-page browser work have hosted native/cloud model evidence; arbitrary-site login portability remains unverified. Native [background subagents](../subsystems/assistant-runtime.md#subagents) also have real assistant/coding evidence. [Verification evidence](../learning/assistant-core-verification.md) distinguishes these claims; no comparative interaction benchmark or replacement call path is established.

### Response voice

Use plain, direct, conversational English. Ordinary replies do not use em dashes or en dashes. They do not open with canned enthusiasm, congratulations, praise, or a claim that Umpi is ready. Do not paraphrase the owner's message merely to acknowledge it. Start with the answer, action, or useful next point. Exact quoted text and explicit punctuation questions keep their original characters.

### One owner for intent and outcome

One capable assistant owns the user's request and its outcome. Do not mechanically route every operation through receptionist → primary agent → read-only assistant.

Give simple calendar and note reads, and small mutations, direct semantic tools. The model interprets intent. Code owns IDs, timezones, authorization, scheduling, deduplication, and delivery state.

Use background workers or subagents for appropriate substantial work, not by default and not specifically as a solution to calls. A foreground tool that waits for a subagent still blocks the conversation. Native [background delegation](../subsystems/assistant-runtime.md#subagents) now leaves the parent available and returns durable results automatically; the parent still integrates and verifies. Coding children stay inside the existing approved run, and browser tasks keep one action owner. This is observed availability in bounded scenarios, not a latency guarantee or background self-approval. The [runtime capability distinctions](../architecture.md#runtime-and-version-constraints) explain what Pi and Cloudflare do and do not supply.

### Durable follow-through and truthful state

- Accepted work survives the user closing chat or ending a call, unless the user explicitly cancels it.
- A correction refers to an existing task and version. It must not create a competing duplicate.
- Admission, execution, completion, and delivery are separate states. Report each truthfully without making the user manage unnecessary internal bookkeeping.
- Deliver asynchronous results coherently and automatically. An acknowledgment of admission is not completion.
- A network disconnect does not prove that a Mac job stopped. Reconcile the existing execution owner before rescheduling the work elsewhere.

The [execution-placement decision](../decisions/2026-10-10-execution-placement.md) preserves the reasoning for Mac-first work. The current [coding-task contract](../subsystems/assistant-runtime.md#coding-tasks) applies that boundary to approved private copies and separately approved owner-uploaded cloud source. Claimed or uncertain Mac work must not move to cloud on silence. The [architecture](../architecture.md#runtime-and-version-constraints) assigns external-effect ownership and uncertain outcomes to application code. A durable task record alone cannot prove that a message, call, write, or deployment happened exactly once; a review patch is not an applied change, and cancellation is not rollback.

### Voice retention criteria

Prior voice trials included waits long enough to break conversational flow after tool requests. Do not preserve calls without demonstrating a better interaction.

Any replacement voice path must demonstrate:

- Responsive ordinary exchanges.
- Responsive small corrections.
- Direct tool actions.
- Continued conversation during longer work.
- Coherent delivery of asynchronous results.

Measure queuing, model response, tool duration, and speech delivery separately when evaluating a replacement. Fast canned acknowledgments do not show genuine conversational availability. This is an acceptance criterion for a replacement, not a claim that such a replacement has been tested.

Calls are optional. Keep them only when actual latency and responsiveness serve a useful purpose. If the real subscription voice transport cannot meet these requirements, omit calls from the new product. Do not make the migration depend on preserving calls.

Do not remove or reconfigure an external caller during research. The native [phone companion](../subsystems/phone-companion.md) implements alarms and structured actions without reproducing a full chat interface. This does not establish a replacement voice path or arbitrary control of other apps.

## History

- 2026-10-10: Earlier failures established intent preservation and follow-through as the goal; observed voice delays made calls conditional on useful responsiveness.
- 2026-10-11: Verified concrete intent-preserving actions and durable follow-through in the text/Mac path without claiming a comparative model-quality benchmark or usable live calls.
- 2026-10-13: Updated the capability boundary for hosted daily follow-through, native phone actions, and model-verified private-copy coding on Mac and cloud. Preserved the distinction between useful asynchronous ownership and deferred general subagents or calls.
- 2026-10-13: Verified genuine parent acknowledgement during native child work and automatic result reconciliation. Added scoped coding delegation without changing voice acceptance criteria or treating delegation as a universal speed improvement.
- 2026-10-14: Made response voice an explicit final prompt section after a canned congratulatory reply failed the natural-conversation criterion. Verified a comparable hosted reply without long dashes, canned praise, or readiness filler.
