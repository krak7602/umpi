# Working in this repository

## Hard rules

- Preserve user work. Inspect relevant files before changing them. Keep unrelated changes out of the task.
- Protect credentials and private account data. Do not put them in source control, logs, screenshots, or image layers. Keep authorized browser-test snapshots in owner-only temporary storage outside this repository.
- Secret-bearing configuration needs non-echoing local operations. Do not use context-printing read/edit tools on these files: adjacent lines can disclose secrets even when the selected fields are public. Verify only redacted metadata.
- Treat the source tree as publishable. Keep owner names, handles, personal note contents, real deployment origins, account IDs, Apple signing/team/key/app identifiers, and device tokens out of source, examples, fixtures, and documentation. These identifiers are private here even when they are not authentication secrets. Use generic examples and private local configuration.
- Keep deployment values in ignored `wrangler.local.jsonc`, native signing values in ignored `*.local.xcconfig`, and credentials in private storage. Keep shared Worker entry points, bindings, migrations, and compatibility settings aligned between public and private configs without overwriting private values. Never add private configuration with `git add -f`. Review publishable files and Git author metadata before the first public commit; `.gitignore` does not remove previously tracked content or history.
- Respect the current request's deployment boundary. Repository preparation and past experiments do not authorize production deployments, new credential uploads, paid features, or changes to installed assistants, browsers, or external apps.
- Distinguish implemented behavior, accepted design, proposals, and observed evidence. Never report a plan or an unrun check as completed behavior.

## Working agreement

- The main assistant owns the user conversation, requirements, decisions, integration, and verified results.
- Delegate substantial independent work with clear ownership, constraints, and acceptance checks. Handle small or tightly coupled changes directly.
- Use clear, direct English inspired by ASD-STE100, with roughly 80% adherence. Prefer short sentences, consistent terms, and explicit actions. Keep exact technical names.
- Reuse existing patterns. Check the affected callers and contracts before changing behavior.
- Verify the changed behavior with an appropriate real command or scenario. For documentation-only work, exercise navigation and check structure and links. Report only checks that ran.
- Update affected documentation with the change. Keep temporary probes and work transcripts out of maintained documentation.
- Use Node 24 or later. Run `npm run typecheck`, `npm test`, and `npm run build` after integration, plus a real changed-path smoke. The build command is a dry run, not a deployment.
- For native changes, regenerate `ios/Umpi.xcodeproj` with XcodeGen, build the app/tests, and exercise the actual simulator app against an isolated coordinator. Keep simulator ad-hoc signing enabled for Keychain. Real push delivery and alarm ringing require separate signed-device evidence; follow the native section of the development runbook.

## Reading routes

Read [README.md](README.md) for the repository entry point. Then select the relevant route:

| If working on | Read first |
| --- | --- |
| System boundaries, executor placement, runtime choices, or costs | [Architecture](docs/architecture.md), then [execution decision](docs/decisions/2026-10-10-execution-placement.md) |
| Coordinator tools, Telegram, reminders, approvals, native core context, or HTTP contracts | [Assistant runtime](docs/subsystems/assistant-runtime.md) |
| Native processes, executor identity, or crash recovery | [Mac executor](docs/subsystems/mac-executor.md) |
| Model providers, OAuth, credential storage, or refresh ownership | [Model authentication](docs/subsystems/model-auth.md) |
| Local setup, hosted deployment, startup, or verification | [Development and operation](docs/runbooks/local-development.md), especially [hosted operation](docs/runbooks/local-development.md#hosted-operation), then [core evidence](docs/learning/assistant-core-verification.md) |
| Intent, task ownership, responsiveness, or voice acceptance | [Interaction quality](docs/concepts/interaction-quality.md) |
| Phone alarms, push delivery, or companion actions | [Phone companion](docs/subsystems/phone-companion.md) |
| Aside access, browser execution, or snapshot refresh | [Browser access](docs/subsystems/browser-access.md), then [snapshot decision](docs/decisions/2026-10-11-browser-snapshots.md) |
| Browser portability claims or technical evidence | [Session portability](docs/learning/browser-session-portability.md) |
| A newly authorized browser verification | [Verification runbook](docs/runbooks/verify-browser-sessions.md) |
| Adding, editing, or moving documentation | [Documentation taxonomy](docs/TAXONOMY.md) |

## Documentation maintenance

- Give each subject one authoritative home. Link to it instead of copying its specification.
- Use the taxonomy's page shape. Rewrite `Current` as understanding changes. Keep `History` brief and meaningful.
- Preserve dated decision reasoning and the evidence available at the time. Link to the current subject page for the current contract.
- Remove obsolete duplication and fix inbound links when moving a page. Check that maintained pages remain reachable from the repository entry point.
- Keep this file below 200 lines. It is a guide to work and reading routes, not a subsystem specification, experiment report, or diary.
