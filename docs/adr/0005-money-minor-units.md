# ADR 0005: Money as integer minor units

Status: accepted · 2026-10-18

## Decision
Money is `bigint` minor units + ISO 4217 currency everywhere (DB, contracts, events, device). `@wise-biz/money` owns arithmetic, allocation (split remainders deterministically), tax rounding (per line or per document, configurable by tax region), cash rounding, and formatting (Intl). Currencies with 0 or 3 decimals handled by the ISO exponent table. FX conversions store the rate snapshot.

## Consequences
No floating-point drift; identical totals on device and server; Django side uses `int` + the same exponent table.
