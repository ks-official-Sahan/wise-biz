# AI features and prompt caching

Status (2026-11-08): wise-biz makes no model API calls today. No package depends on an Anthropic SDK, and the Store MCP and DSS assistant (`docs/architecture/mcp.md`) are not built. The only model use is CI review (`.github/workflows/claude*.yml`). This page fixes the caching rules that the first model-calling code must follow, so they are not invented per feature.

## Rules for any code that calls a model

1. **Order the prompt from most stable to most volatile.** Tool definitions, then the system prompt, then tenant-independent reference text (glossary, permission catalogue, report definitions), then the tenant's configuration, then the conversation, then the current question. A change early in the prompt invalidates everything after it.
2. **Put explicit cache breakpoints at the boundaries of that order**: after the tool and system block (shared by every tenant), after the tenant block (shared by one tenant's sessions). Use at most the number of breakpoints the API allows; do not put one on the volatile tail.
3. **Keep the cached prefix byte-stable.** Sort tool lists and JSON keys, no timestamps, request ids, user names or random ordering inside it. Version the prefix (`PROMPT_VERSION`) so a deliberate change is visible in logs.
4. **Tenant isolation first.** Treat a cache entry as reusable by any request of the same account (check the provider's isolation rules when you build this), so never place one tenant's data in a prefix that another tenant's request reuses. Anything tenant-specific sits after the shared breakpoint. Never cache secrets, PII or card data (`CLAUDE.md`: do not put them in prompts).
5. **Use the longer cache lifetime only for prefixes that are reused across minutes** (assistant sessions, report explainers). Short-lived one-shot prompts use the default.
6. **Measure.** Log cache read and write token counts per call (`cache_read_input_tokens`, `cache_creation_input_tokens`) through `@wise-biz/observability`; alert when the hit rate for a stable prefix falls below the level seen at launch. A prefix that is too short for the minimum cacheable size is not cached; check the model's minimum before adding a breakpoint.
7. **Budget and audit.** Each call goes through a wrapper that enforces a per-tenant token budget, redacts logs, and writes an audit row for any action the model triggers (the upstream `ai-core` budget hooks, `docs/research/sahan-packages.md`). Controlled actions need the same authorization as the API.
8. **Look up the current API before coding it** (non-negotiable 11): cache control syntax, minimum sizes and lifetimes change.

## CI review (exists today)

`claude-pr-review.yml` shards a pull request into batches and runs one read-only model call per batch. Each call has the same instruction block and a different batch file, so the instruction block is the stable prefix. Keep new project guidance in `AGENTS.md` and the workflow prompt, not in per-batch files, so it stays in that prefix. The pull request's own `.claude/` configuration is removed before the call (the checkout is attacker-controlled).
