# Generate the next phase's steps

Paste this into a fresh session (Opus, effort **High**) at a phase gate.

---

Act as wise-biz lead architect and prompt engineer. Generate the build steps for phase **{P3 | next}**.

Read, in this order and nothing else unless needed: `AGENTS.md`, `docs/ROADMAP.md` (target phase + risks), `docs/prompts/PROGRESS.md` (follow-ups, decisions), the latest `docs/reports/P*-gate.md`, `docs/modules.md`, and `ARCHITECTURE.md` (Django readiness) if the phase extracts services.

Rules:
1. Each step is one PR-sized slice (≤ ~1,500 changed lines), independently verifiable, ordered by dependency; mark parallel tracks.
2. Prefer extending existing modules and patterns over new frameworks (ponytail). New runtime (e.g. Django service) only with an extraction trigger from ADR 0001 and an ADR.
3. Every step lists exact docs/sections to read, libraries to check with Context7, skills, delegation with disjoint paths and models (`wb-*` agents; haiku for mechanical, sonnet for logic/UI/DB), runnable acceptance checks, and reviewers.
4. Effort tag: H for architecture, security, money, sync, payments, data migration, gates; M otherwise.
5. End with a gate step.
6. Write files to `docs/prompts/<phase>/NN-<slug>.md` using the template below, add a phase table to `docs/prompts/README.md`, and add rows to `PROGRESS.md`.
7. Show me the step list (titles, effort, needs) before writing files.

Candidate scope for P3 (from ROADMAP): first service extraction (likely insights/reporting → Python/Django for ML), Django tier for AI agents and custom LLMs behind the gateway, restaurant mode + kitchen display, white-label builds, wallet passes, HarmonyOS evaluation (React Native for OpenHarmony vs PWA), ERP modules (GL, AP/AR, HR, procurement).

---

## Step template

```markdown
# <ID> · <Title>

Effort: **H|M** · Needs: <ids> · Gate: <none | confirm plan | decision: …>
Read: <file (section)>, …
Libraries: <names to check with Context7>
Skills: <skill names>

## Goal
<1–2 sentences: the user-visible or system outcome>

## Scope
1. <concrete, testable items; name packages/modules/tables/endpoints/screens>

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | <lookups> |
| 2 | wb-… (sonnet|haiku) | <exact paths> | <items> |

## Acceptance
- <runnable command or observable behavior with a number>

## Out of scope
<what waits for later>

## Review
<ecc reviewer agents>
```
