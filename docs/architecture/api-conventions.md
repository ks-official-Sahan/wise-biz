# API conventions

Contract-first. Zod in `@pos/contracts` → OpenAPI 3.1 (HTTP) + AsyncAPI 3 (events). Node and future Django implement the same contracts.

## Shape

- REST over HTTPS, JSON. Base `/v1`. Module prefix: `/v1/sales/…`, `/v1/inventory/…`.
- Device sync: `POST /v1/sync/commands` (batch), `GET /v1/sync/changes?dataset=&cursor=`.
- Resource IDs are UUIDv7; human numbers are fields, not path IDs.
- `camelCase` JSON; `snake_case` DB.

## Headers

| Header | Use |
|---|---|
| `Idempotency-Key` | Required on every POST/PATCH that creates or changes state. Stored 24 h (Redis) + DB unique where natural (sale id). Same key + different body → `422 IDEMPOTENCY_MISMATCH` |
| `If-Match` | Optimistic concurrency with `ETag` = row version on updates |
| `X-Tenant-Id` | Only for platform tools; normal callers get tenant from token |
| `X-Request-Id` | Echoed; generated at edge if missing |
| `Signature`, `Signature-Input`, `Content-Digest` | Device and platform-MCP requests (RFC 9421) |

## Errors (RFC 9457 problem details)

```json
{ "type": "https://errors.pos.dev/stock/insufficient", "title": "Insufficient stock", "status": 409,
  "code": "STOCK_INSUFFICIENT", "detail": "…", "requestId": "…", "errors": [{ "path": "lines[2].qty", "message": "…" }] }
```

Stable `code` values; clients switch on `code`, never on text.

## Lists

- Keyset pagination: `?limit=50&after=<cursor>`; cursor = opaque base64 of `(sortKey, id)`. Max limit 200.
- Filters explicit (`?branchId=&from=&to=`). Sorting from an allowlist.
- `?include=lines,tenders` expands related data with **one batched query per relation** (no N+1). Includes are allowlisted per endpoint.

## Validation chain

1. Shape (zod).
2. Reference checks batched (all variant IDs in one `where id = any($1)`).
3. Business rules (domain layer, pure).
4. Policy (amount limits, overrides).
5. DB constraints as the last guard.

Each step returns all its errors at once.

## Versioning

- Additive changes in place. Breaking → `/v2` route or new event version; old served ≥ 6 months for devices (offline devices may be old).
- Device sends `X-App-Version`; server can return `426 UPGRADE_REQUIRED` with minimum version.

## Webhooks out

Signed (`HMAC-SHA256`, timestamped), retried with backoff up to 24 h, delivery log in console, replay button. Event payloads match AsyncAPI.

## Rate limits

`RateLimit` / `RateLimit-Policy` headers (IETF draft). Buckets: per IP (edge), per token, per tenant, per device. 429 with `Retry-After`.
