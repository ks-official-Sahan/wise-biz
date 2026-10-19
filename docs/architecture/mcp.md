# MCP servers

Two servers, separate deployments, separate credentials, shared `@pos/mcp-core` (tool registry, policy guard, audit, rate limit, confirmation tokens).

Tools call **the same application use cases** as the API. MCP never queries tables directly, so permissions, validation, audit, and outbox apply identically.

## Store MCP (`apps/mcp-store`)

For tenant owners and managers in any MCP client.

| Aspect | Rule |
|---|---|
| Auth | OAuth 2.1 + PKCE via identity module; token audience `mcp-store`; scopes map to permissions; tenant fixed in token |
| Authorization | Every tool declares `permission` + `scope`; checked with `@pos/policy` for the token's user; branch-narrowed memberships apply |
| Entitlement | Tool family gated by plan (`mcp.store` entitlement) |
| Reads | Reports, sales search, stock levels, low stock, expiring batches, top products, staff performance, customer lookup (PII masked unless `customers:view_pii`) |
| Writes | Price change, promotion create/pause, stock adjust (with reason), PO draft, staff role change, device suspend, theme publish |
| Write safety | Two-step: tool returns a **preview + confirmation token** (diff, impact counts, 5 min TTL); second call with token executes. Bulk writes capped (e.g. 500 rows) |
| Limits | Per-token rate limits; query result row caps; date ranges capped by plan |
| Audit | `actor.type = mcp`, client name, tool, args hash, result summary |
| Prompt injection | Tool outputs mark user-generated text (product names, notes) as data; ai-core `guard` applied to any LLM-assisted tool |

Example tools: `sales_summary`, `top_products`, `stock_level`, `low_stock`, `expiring_batches`, `stock_gap_report`, `find_sale`, `adjust_price` (confirm), `create_promotion` (confirm), `adjust_stock` (confirm), `suspend_device` (confirm), `explain_metric` (ai-core narrative).

## Platform MCP (`apps/mcp-platform`)

For the platform owner only. All-access, with guard rails.

| Aspect | Rule |
|---|---|
| Network | Private: reachable only via Cloudflare Access / Zero Trust tunnel + IP allowlist |
| Auth | OAuth 2.1 + passkey step-up per session; request signing (RFC 9421) with a hardware-backed key |
| Scope | Cross-tenant tools require explicit `tenantId` arg; no implicit "all tenants" writes |
| Dry run | Every write supports `dryRun: true` (default true for bulk) |
| Snapshots | Before any write: snapshot affected rows (JSON, compressed) into `audit.snapshots` with `snapshot_id`, linked to the audit row |
| Restore | `list_snapshots`, `diff_snapshot`, `restore_snapshot` (itself snapshotted, so restore is undoable). Restores run as a compensating transaction, not row overwrite, when later changes touched the same rows → conflict report |
| Destructive | Delete tenant, purge data, rotate keys, mass refunds: two-person rule (second admin confirms in console) + typed confirmation phrase |
| Rate | Hard cap on writes per minute; kill switch flag disables all writes |
| Audit | Everything, plus Merkle-anchored daily |

Tool families: tenants (create, suspend, plan change, grant pay-as-you-go features), devices (global blacklist), billing (credits, trial extend), support (impersonate read-only with glass-break), ops (DLQ replay, projection rebuild, cache purge, feature flags), data (export, backup trigger, restore).

## Shared core (`@pos/mcp-core`)

```ts
defineTool({
  name: "adjust_price",
  permission: "pricing:update",
  entitlement: "mcp.store",
  mode: "confirm",            // read | confirm | destructive
  input: AdjustPriceInput,    // zod
  preview: (ctx, input) => …, // returns diff + impact
  run: (ctx, input) => useCases.pricing.adjustPrice(ctx, input),
});
```

Guard order: auth → tenant resolve → entitlement → permission → rate limit → validate → (preview/confirm) → snapshot (platform) → run → audit.

Transport: Streamable HTTP. Stateless handlers; session state (confirmation tokens) in Redis.
