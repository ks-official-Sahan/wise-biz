# P2-15 · Support tickets + announcements

Effort: **M** · Needs: P1-16 · Gate: none
Read: `docs/modules.md` (support, notifications)
Skills: `ux-principles`

## Goal
Tenants ask for help inside wise-biz with context attached; the platform team answers and announces changes.

## Scope
- Tickets: create from console or POS (auto-attach app version, device, last errors, tenant/branch; never PII or secrets), statuses, priorities, SLA timers by plan, messages with attachments (media-kit), email notifications.
- Platform console: queue, assignment, canned replies, link to read-only glass-break request (from P2-11).
- Announcements: targeted by plan/country/app version; in-app banner + changelog page.

## Delegation
wb-db (haiku) tables → wb-builder (haiku) use cases (escalate to sonnet if stuck) → wb-ui-builder (sonnet) screens → wb-tester (haiku).

## Acceptance
- Ticket from POS includes diagnostic bundle without PII (test scans payload); SLA timers correct across timezones.

## Review
`ecc:security-reviewer` (attachments, PII)
