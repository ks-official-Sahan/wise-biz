# ADR 0021: The approvals inbox reads existing sources first; no approval engine yet

Status: accepted · 2026-11-05 (confirmed by the owner)

## Context
`docs/design/ux.md` calls for an approvals inbox in the console: overrides, large stock adjustments, price changes that need approval, and device enrollments. Today only two of those exist as data: sales flagged "needs review" (supervisor overrides recorded by terminals) and devices waiting for approval. Large stock adjustments and price changes need approval rules and a workflow that no module owns.

## Decision
- Build the inbox as a console page that lists items from the modules that already own them, through their contracts and with the existing permissions (`sales:read` for reviews, `devices:read` for pending devices). No module reads another's tables.
- Each row links to the screen that already lets the person act (the sale, the device). The inbox adds no new write path.
- The nav badge shows the sum of the open counts, from one batched request.
- Approval rules for stock adjustments and price changes (who may approve, thresholds, expiry) are not built now. They need their own ADR when P2 defines them, and will add sources to the same inbox.

## Consequences
- The inbox ships without a new table, event or permission.
- Anyone who expects an "approve" button for price changes will not find one until the rules exist.
- Confirmed by the owner on 2026-11-05; the inbox is built as described, without the approval rules for stock adjustments and price changes.
