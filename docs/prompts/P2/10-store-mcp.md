# P2-10 · Store MCP

Effort: **H** · Needs: P2-09 · Gate: confirm tool list
Read: `docs/architecture/mcp.md` (Store MCP, Shared core), `docs/architecture/security.md` (Authorization)
Libraries: MCP TypeScript SDK (Streamable HTTP transport, OAuth 2.1 auth), `@sahan-sac/ai-core` (guard, narratives)
Skills: `ecc:mcp-server-patterns`, `ecc:mcp-dependency-review`, `ecc:agent-security-hardening`, `ecc:security-review`

## Goal
Store owners manage and query their business from any MCP client, with the same permissions, validation, audit, and confirmation safety as the console.

## Scope
- `@wise-biz/mcp-core`: `defineTool` (permission, entitlement, mode read|confirm|destructive, zod input, preview, run), guard pipeline order from mcp.md, confirmation tokens in Redis (5 min), row caps, rate limits, audit with `actor.type = mcp`.
- `apps/mcp-store`: OAuth 2.1 + PKCE via identity, scopes → permissions, tenant fixed by token; tools from mcp.md list; tools call application use cases only.
- Output hygiene: user-generated text marked as data; PII masked unless permitted; ai-core guard for any LLM-assisted tool (`explain_metric`).
- Docs page in console: connect instructions per client, token management, revoke.

## Delegation
wb-researcher (haiku) MCP SDK current auth + transport → wb-builder (sonnet) mcp-core → wb-builder (sonnet) tools (split read vs write across two agents) → wb-tester (sonnet) permission matrix + injection tests.

## Acceptance
- Every tool: unauthorized → not listed / 404; write without confirmation token does nothing; prompt-injection strings in product names cannot trigger writes.
- Audit shows each MCP call with client name and args hash.

## Review
`ecc:security-reviewer` (mandatory), `ecc:typescript-reviewer`
