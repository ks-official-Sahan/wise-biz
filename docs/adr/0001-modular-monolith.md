# ADR 0001: Modular monolith with service seams

Status: accepted · 2026-10-18

## Context
The product needs microservice-level boundaries (independent scaling, Django migration, ERP growth) but starts with a small team. Full microservices now would add distributed transactions, network failure modes, and ops cost before any module needs them.

## Decision
One deployable `apps/api` that mounts modules. Each module: own Postgres schema, hexagonal layout (domain / application / ports / adapters), contracts in `@pos/contracts`, events via transactional outbox. Cross-module calls only through ports or events. `dependency-cruiser` blocks forbidden imports in CI.

## Consequences
- Sale + stock movement stay in one ACID transaction while co-located.
- Extracting a module = move its schema + adapters; swap its port implementation to HTTP/gRPC; consumers already use events.
- Extraction triggers: independent scaling need, different runtime (Python/ML), separate team, or noisy-neighbor load.
- Workers, realtime, and MCP servers are separate deployables from day one (different scaling profiles).
