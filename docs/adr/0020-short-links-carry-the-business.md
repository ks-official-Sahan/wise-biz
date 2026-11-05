# ADR 0020: Short links carry their business in the path and in the KV key

Status: accepted · 2026-11-05

## Context
The edge Worker resolves public short links from Workers KV. The first version used `/s/:code` and the key `s:<code>`. A public link has no session, so the edge cannot learn the business from the request, and AGENTS.md requires every cache key to carry `tenant_id`. With no business in the key, two businesses that pick the same code would overwrite or shadow each other once anything writes to the namespace. Nothing writes to it yet, so the shape can change without a migration.

## Decision
- The public path is `/s/:tenant/:code`. `:tenant` is the business's UUID, `:code` is 3 to 32 characters of `[0-9A-Za-z_-]`.
- The KV key is `s:<tenant>:<code>`. Both parts are validated before the lookup; a path with any other shape answers 404.
- Targets must be https URLs, as before.
- Any writer (a future API endpoint in the owning module) must use the same key and must check the caller's business, so a business can only create keys under its own id.

## Consequences
- Links are a little longer (a 36-character id). A custom host per business (`shop.example.com/s/code`) can map the host to the business later without changing the key.
- The old `/s/:code` shape is gone. It never had a writer, so no link in the wild breaks.
- Receipt links (`/r/:code`) are unaffected: they go to the API, which looks the business up from the code.
