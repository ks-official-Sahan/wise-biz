# ADR 0014: Terminal sales are re-priced and rejected only for the same pricing inputs; one device chain per terminal

Status: accepted · 2026-10-31

## Context
P1-05 applies sales that terminals completed offline. The server must catch a broken or tampered device total, but the customer has already paid and left: rejecting a sale only because prices changed while the terminal was offline loses a real sale. `<listId>:<version>` covers list prices only. Promotions, coupons, fees and tax regions can change without a list version bump, and the quote only loads promotions that are published now.

Every signed document (sale, return, void, shift open and close, drawer, cash movement, override) also carries a device sequence number and a hash chain. A sequence number that is unique per table only lets a void and a sale share one number.

## Decision
- **Re-price at the document time** (`completedAt`) through the pricing port, with the device's lines (override prices, batches) and coupons.
- **Reject (`PRICE_MISMATCH`, 409) only when the device priced with the same inputs.** That means the list snapshot `<listId>:<version>`, the engine version, and the set of applied promotions (`promotionIds` on the command) all match the server's. Then a difference within tolerance (`max(minMinor, bps × payable)`, default 1 minor unit / 50 bps) is accepted and flagged `price_mismatch`, and beyond it the sale is rejected with nothing written.
- **Any other difference is accepted and flagged `stale_price`:** an older snapshot, a promotion that ended, or a cart the server can no longer price (the quote's validation error, raised before any failing SQL, so the transaction is still usable).
- Operator status and policy snapshot follow the same rule: an inactive or unauthorized operator, or an older `policyVersion`, is flagged (`operator_inactive`, `operator_unauthorized`, `stale_policy`), never refused.
- **One chain table**, `sales.device_documents(tenant, terminal, device_seq)` primary key, stores doc type, doc id, prev_hash, hash and signature for every signed document. Sync (P1-06) verifies the chain against it. Document ids are the idempotency keys: the same id and hash from the same terminal replays the stored answer, and anything else under that id is a `CONFLICT`. Applies of one id are serialized by a transaction advisory lock.

## Consequences
- A device can never get a sale rejected because of a server-side price or promotion change. Tampering with the same inputs is caught.
- Reviewers find flagged sales through `sales_tenant_flagged_idx`, and reports show stale-price sales separately.
- Devices must send `promotionIds`. A command without them is compared against an empty set, so any applied promotion makes it `stale_price` rather than a rejection.
- P1-06 has one chain to verify per terminal, whatever the document type.
