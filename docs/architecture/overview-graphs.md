# Architecture graphs

Maps of the system as built (2026-11-08). Sources: `ARCHITECTURE.md`, `docs/modules.md`, `modules/registry.json`, `.dependency-cruiser.cjs`, ADRs 0001, 0003, 0006, 0014, 0015, 0016. If a graph and the code disagree, fix the graph. Regenerate the real import graph with `pnpm deps:graph`.

## Structure: who may import whom

```mermaid
flowchart TB
  subgraph clients["Clients (apps/)"]
    pos["pos (Expo, RN web)"]
    desktop["desktop (Electron shell)"]
    console["console (Next.js)"]
    gallery["ui-gallery"]
  end
  subgraph services["Server processes (apps/)"]
    api["api (Hono)"]
    workers["workers (relay, consumers, jobs)"]
    realtime["realtime (SSE, no DB)"]
    server["server (api + workers, one process)"]
    edge["edge (Cloudflare Worker)"]
  end
  mods["modules/* (one schema each, forced RLS):<br/>identity, tenancy, devices, catalog, pricing, inventory,<br/>sales, sync, search, reporting, notifications, theming,<br/>procurement, shortlinks, audit, infra"]
  subgraph pk["packages/* (framework-free)"]
    contracts
    money
    ids
    policy
    events
    module_kit["module-kit"]
    db
    sync_client["sync (device)"]
    pricing_engine["pricing-engine"]
    ui
  end
  pos --> sync_client
  pos --> pricing_engine
  pos --> ui
  pos --> contracts
  desktop --> pos
  console --> contracts
  console --> ui
  api --> mods
  workers --> mods
  server --> api
  server --> workers
  edge --> api
  realtime -. "Redis hints" .-> workers
  mods --> module_kit
  module_kit --> db
  mods --> contracts
  mods --> events
  mods --> policy
  mods --> money
  mods --> ids
  mods -. "ports or events only, never tables" .-> mods
  Postgres[("Postgres 18 + RLS")]
  Redis[("Redis")]
  Obj[("S3 / R2")]
  db --> Postgres
  api --> Redis
  workers --> Redis
  workers --> Obj
```

Enforced by `pnpm depcruise`: modules never import `apps/`, packages never import frameworks, domain code never imports adapters, infra or Node I/O, no cycles, no deep imports into another module.

## State: a sale, from scan to ledger

```mermaid
stateDiagram-v2
  [*] --> Cart: scan or search (local SQLite)
  Cart --> Parked: park
  Parked --> Cart: resume
  Cart --> Tendering: pay
  Tendering --> Committed: commitSale (ONE local tx: sale no, shift, stock, outbox row, draft removed)
  Committed --> Pending: outbox command signed, chained
  Pending --> Pushed: push batch (RFC 9421 signed)
  Pushed --> Applied: server completes sale (re-price, ledger, audit, outbox event)
  Pushed --> Rejected: refused (kept for the operator)
  Pushed --> Pending: lost answer, resend (server replays)
  Pending --> Blocked: device suspended, chain failure
  Applied --> Voided: void (window, override)
  Applied --> Returned: return (partial, capped)
  Voided --> [*]
  Returned --> [*]
  Applied --> [*]
```

Checkout never waits on the network: everything up to `Pending` runs against local SQLite (non-negotiable 4).

## State: an event, from mutation to consumer

```mermaid
stateDiagram-v2
  [*] --> Outbox: mutation tx (audit row + outbox row together)
  Outbox --> Claimed: relay claims with a lease
  Claimed --> Published: consumers done or dead-lettered
  Claimed --> Outbox: failed, lease released
  Claimed --> Outbox: crash, lease expires, redelivery
  Outbox --> Quarantined: attempts exhausted
  Published --> Pruned
```

Delivery is at-least-once; consumers dedupe on `processed_events`. Order per key is only guaranteed by the Kafka adapter (see `events.md`), so consumers must tolerate reordering.
