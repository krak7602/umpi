---
title: Documentation taxonomy
aliases: [documentation policy, knowledge map, repository working agreement]
updated: 2026-10-14
---

# Documentation taxonomy

## Current

### Purpose

Documentation is a maintained knowledge and retrieval system. It is not a transcript of work. Give each subject one authoritative home. Other pages link to that home instead of copying its specification.

Use clear, direct English inspired by ASD-STE100. Aim for roughly 80% adherence, not formal compliance. Use short sentences, consistent terms, and explicit actions. Keep exact technical names.

### Homes

| Question | Home |
| --- | --- |
| What are the system boundaries and major relationships? | [architecture.md](architecture.md) |
| How does a subsystem work, or what is its explicitly labelled design? | `subsystems/` |
| What reusable principle guides the choices? | `concepts/` |
| Why was a choice made? | `decisions/` |
| How is a repeatable operation performed? | `runbooks/` |
| How can a reader understand and reconstruct an idea or its evidence? | `learning/` |
| How is documentation maintained? | This page |

Create only categories with real content. Use `diagrams/` if a standalone diagram becomes necessary; do not create an empty directory for it. Keep an inline diagram with its authoritative subject when a separate file adds no value.

[README.md](../README.md) is the human entry point and navigation map. [AGENTS.md](../AGENTS.md) contains hard rules, working agreements, conditional reading routes, and documentation maintenance rules. These entry points are not extra homes for subsystem specifications.

### Durable subject pages

Use this shape for architecture, subsystem, concept, runbook, and learning pages:

```markdown
---
title: Human-readable title
aliases: [alternate terms, old names, abbreviations]
updated: YYYY-MM-DD
---

# Human-readable title

## Current
A coherent explanation of the latest understanding.

## History
- YYYY-MM-DD: A meaningful change and its reason; link to a decision when relevant.
```

Use lower-level headings inside `Current`. State whether a description is existing behavior, accepted but unimplemented design, a proposal, an observed result, or an unresolved question. `Current` means current knowledge; it does not turn a proposed system into an implemented one.

Rewrite `Current` when understanding changes. Keep `History` brief. Do not log every task, edit, failed command, or mechanical file move.

A learning page may preserve a coherent historical experiment as evidence. Keep its method, important findings, limits, and diagnostic lessons together. Do not preserve the work transcript. A runbook owns the repeatable operation, not another copy of the result table.

### Dated decisions

Use `YYYY-MM-DD-short-subject.md` under `decisions/`. Include `title`, `aliases`, `updated`, and `status` in YAML frontmatter. Use these sections in order:

1. `Context`
2. `Decision`
3. `Consequences`
4. `Evidence`

Record why the choice made sense and what evidence was available. Distinguish an accepted policy from an undecided implementation choice. Link to the current subject page for its operating contract. Do not keep a second mutable specification in the decision record.

If a later decision replaces an earlier one, add a dated record and link the two. Preserve the earlier reasoning. Do not silently rewrite history to imply that later evidence was known earlier.

### Maintenance with changes

- Find the authoritative page before creating another one. Check titles, aliases, and the entry-point links.
- Update affected pages in the same change as the code or decision. Update the metadata date when the page's knowledge changes.
- Keep evidence and uncertainty explicit. Preserve source links and distinguish published claims from locally observed behavior.
- Remove stale duplication. After moving a page, update inbound links and remove the obsolete copy; do not leave forwarding stubs by default.
- Check relative links, heading fragments, and reachability from `README.md`. Keep `AGENTS.md` below 200 lines.
- Keep credentials, private snapshots, scratch notes, transcripts, and throwaway scripts out of maintained documentation. Record redacted outcomes instead.
- Do not invent build, test, or deployment commands for tools that are not present. Document usable commands when the implementation exists.

## History

- 2026-10-11: Adopted the repository working agreement. Separated current knowledge, decision reasoning, repeatable operations, and evidence so each subject has one maintained home.
