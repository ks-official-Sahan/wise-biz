# P2-14 · DSS insights + AI narratives

Effort: **H** · Needs: P2-02, P2-04 · Gate: confirm insight list and evaluation method
Read: `SYSTEM.md` (DSS row), `docs/modules.md` (insights), `docs/research/sahan-packages.md` (ai-core)
Libraries: `@sahan-sac/ai-core` (provider chain, guard, budgets from P0-11), simple forecasting (start with exponential smoothing / seasonal naive in TS; Python later only with evidence)
Skills: `ecc:cost-aware-llm-pipeline`, `ecc:eval-harness`, `inventory-demand-planning`, `ecc:mle-workflow`

## Goal
Tell owners what to do next, with reasons they can check, at a predictable AI cost.

## Scope
- Rules + statistics first: reorder point and quantity per variant/location (lead time, demand variability), expiry-risk score, slow movers, price elasticity hints (only with enough data), anomaly detection on operator behavior (voids, no-receipt returns, drawer opens, discounts) and on sales drops.
- `suggestions` with evidence links, accept/dismiss feedback, and actions (create PO draft, promotion draft, investigation case).
- AI narratives via ai-core: summarise a week, explain a metric change; structured output, per-tenant budget, cache by input hash, guard against injection, never invent numbers (numbers come from tools/rollups only).
- Evaluation harness: backtests for forecasts (MAPE/WAPE per segment), golden sets for narratives.

## Delegation
wb-builder (sonnet) statistics + rules → wb-builder (sonnet) ai narratives + budgets → wb-ui-builder (sonnet) insights inbox → wb-tester (sonnet) backtests + eval harness.

## Acceptance
- Forecast backtest beats seasonal-naive baseline on seeded realistic data, or the feature ships as rules-only (record the decision).
- Narratives contain only numbers present in the tool context (automated check).
- AI spend per tenant stays within budget; requests degrade gracefully when exhausted.

## Review
`ecc:security-reviewer` (prompt injection), `ecc:typescript-reviewer`
