# ADR 0005: Money as integer minor units

Status: accepted · 2026-10-18

## Decision
Money is `bigint` minor units + ISO 4217 currency everywhere (DB, contracts, events, device). `@wise-biz/money` owns arithmetic, allocation (split remainders deterministically), tax rounding (per line or per document, configurable by tax region), cash rounding, and formatting (Intl). Currencies with 0 or 3 decimals handled by the ISO exponent table. FX conversions store the rate snapshot.

## Consequences
No floating-point drift; identical totals on device and server; Django side uses `int` + the same exponent table.

## Addendum · 2026-10-19 (P0-04): TypeScript representation

Status: accepted

- In TypeScript (`@wise-biz/money`, contracts, events, device), minor units are a JS `number` that must satisfy `Number.isSafeInteger`; every constructor and operation result is checked and throws `MoneyOverflowError` otherwise. 2^53 − 1 minor units (~9×10^13 at 2 decimals) is far beyond any POS amount.
- Why not `bigint` in TS: no JSON support (custom serializers on every wire and storage path), slower arithmetic on Hermes, and awkward interop with Intl and React state. Intermediate products that could exceed 2^53 (ratio, bps, tax) are computed with `bigint` internally and converted back through the same safe-integer check.
- Database columns stay `bigint` (Drizzle `mode: 'number'`); the safe-integer guard is the contract between them. Django keeps Python `int`.
- The rest of this ADR is unchanged: integer minor units + ISO 4217 code, rounding only in `@wise-biz/money`.
