# P2-11 · Platform MCP, snapshots, restore, glass-break

Effort: **H** · Needs: P2-10 · Gate: confirm plan + threat model review
Read: `docs/architecture/mcp.md` (Platform MCP), `docs/architecture/security.md` (Glass-break, Monitoring)
Libraries: MCP TypeScript SDK, Cloudflare Access/Tunnel, RFC 9421 signing (`@wise-biz/http-signatures`)
Skills: `ecc:mcp-server-patterns`, `ecc:agent-security-hardening`, `red-team-tactics` (for the threat model), `ecc:security-review`

## Goal
The platform owner can operate everything through an MCP, with every change snapshotted, reversible, rate-limited, and dual-controlled when destructive.

## Scope
- `apps/mcp-platform`: private network only (Access + Tunnel + IP allowlist), OAuth + passkey step-up per session, signed requests with a hardware-backed key.
- Snapshots: before every write, capture affected rows (compressed JSON) into `audit.snapshots` linked to the audit row; `list_snapshots`, `diff_snapshot`, `restore_snapshot` (itself snapshotted; compensating transaction; conflict report if rows changed since).
- Dry-run default for bulk; hard write caps per minute; kill-switch flag; two-person rule for destructive tools (second admin confirms in platform console) + typed confirmation phrase.
- Tool families from mcp.md (tenants, devices, billing, support, ops, data).
- Glass-break flow: request + approve by two admins, time-boxed watermark session, tenant notified, loud audit.
- Threat model doc `docs/architecture/threat-model-platform-mcp.md`.

## Delegation
wb-db (sonnet) snapshots → wb-builder (sonnet) server + guards → wb-builder (sonnet) restore engine → wb-ui-builder (sonnet) approvals UI → wb-tester (sonnet) restore conflicts + abuse cases. One `model: "opus"` review of the threat model.

## Acceptance
- Any platform write can be restored; restore of a restore returns to the prior state; conflicts reported, not overwritten.
- Destructive tool without second approval does nothing; kill switch blocks all writes within one request.

## Review
`ecc:security-reviewer` (mandatory), `ecc:database-reviewer`
