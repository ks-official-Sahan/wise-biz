# P0-10 · Console shell (owner + platform admin)

Effort: **M** · Needs: P0-08, P0-09 · Gate: none
Read: `docs/design/ux.md` (Management UI), `docs/architecture/security.md` (Web security), `docs/research/sahan-packages.md` (Admin panel patterns)
Libraries: Next.js (current major — read `node_modules/next/dist/docs/` after install; the Sahan repo warns APIs changed), `@sahan-sac/auth-kit-client`, TanStack Query, react-native-web (for `@wise-biz/ui` in Next) or the web build of the chosen styling system, Playwright
Skills: `vercel-react-best-practices`, `ecc:nextjs-turbopack`, `impeccable`, `emil-design-eng`, `ux-principles`, `accessibility-audit`

## Goal
A fast, accessible console where an owner finishes onboarding, manages people and roles, and reads the audit log. It becomes the frame for every later management screen.

## Scope
1. `apps/console`: App Router; auth via auth-kit-client (sign in, passkey, MFA, sign out, sessions list); strict CSP with nonces + security headers (auth-kit `security/csp`, `security/headers`); unauthorized routes → 404.
2. Layout: responsive sidebar (collapses to bottom nav on phone), top bar with tenant/branch switcher, notification bell (placeholder), command palette (`Ctrl/Cmd+K`) with navigation + actions registry, nav badges API.
3. Onboarding wizard (after sign-up): business name, country, currency, timezone, tax region, first branch, invite staff (skippable). Autosaved draft.
4. People: members list (keyset pagination, search), invite, role assignment with branch scope; Roles: permission matrix editor grouped by module with "what this allows" text; changes show a summary before save.
5. Audit log viewer: filters (actor, entity, action, date), detail drawer with before/after diff, export CSV (permission-gated, itself audited).
6. Settings: business profile, branches, locations.
7. TanStack Query conventions: query keys include tenantId; `staleTime` by data class; prefetch on hover.
8. Route bundle budget ≤ 200 KB gzip; add `@next/bundle-analyzer` script.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | Next.js current routing/CSP nonce pattern; using RN components on web in Next with the chosen styling system |
| 2 | wb-builder (sonnet) | `apps/console/src/lib/**`, `apps/console/middleware*`, API client | Items 1, 7, 8 |
| 3 | wb-ui-builder (sonnet) | `apps/console/src/app/(app)/**` layout, palette, onboarding | Items 2–3 |
| 4 | wb-ui-builder (sonnet) | people, roles, audit, settings routes | Items 4–6 |
| 5 | wb-tester (haiku) | `apps/console/e2e/**` | Playwright flows |

## Acceptance
- Playwright: sign up → onboarding → invite → assign role → see audit entries; unauthorized URL shows 404.
- Lighthouse (mobile) on dashboard, people, audit: accessibility ≥ 95, best practices ≥ 95; CSP header present with nonce.
- Bundle report: no route > 200 KB gzip JS.
- Screens at 390/834/1440 px reviewed against ux.md.

## Review
`ecc:react-reviewer`, `ecc:security-reviewer`, `ecc:a11y-architect`
