# P1-16 · Phase gate: sell and stock offline + pilot readiness

Effort: **H** · Needs: all P1 steps ✅ · Gate: report to me before tagging and starting pilots
Read: `docs/ROADMAP.md` (P1 exit), `SYSTEM.md` (targets, failure modes), `PRODUCT.md` (Success metrics), `docs/prompts/PROGRESS.md`
Skills: `ecc:production-audit`, `ecc:verification-loop`, `ecc:benchmark`, `accessibility-audit`, `qa`

## Goal
Prove a store can run its day on wise-biz, online and offline, before real customers depend on it.

## Checks
1. **Full flows** (Playwright + Maestro + Electron): signup → onboarding → catalog import → receive stock → enroll terminal → shift → 50 sales mixed tenders → returns/void → shift close → reports and exports.
2. **Offline chaos drill** (script in `scripts/drills/offline.ts` + manual checklist): network cut mid-sale, app killed mid-commit, device clock +2 h, two terminals selling the same last unit, 24 h offline with 2,000 sales then reconnect. Expect zero lost sales, negative-balance exceptions raised, sync lag p95 ≤ 10 s for 1k queued sales.
3. **Performance** on a low-end Android and a mid-range Windows PC: scan→line, add→totals, tender→commit, print start against SYSTEM.md budgets. Record in `docs/reports/P1-perf.md`.
4. **Load** (k6 on staging): checkout command rate and sync burst from P1-06; API p95 targets.
5. **Security**: `/ecc:security-scan`, `ecc:security-reviewer` across devices, sync, payments, desktop; secrets and logs scan for PII; dependency audit.
6. **Accessibility**: console and POS web audits; screen reader spot checks on Android and iOS.
7. **Restore drill** repeated from P1-15.
8. **Usability**: test script for 5 cashiers + 3 owners (ux.md Research and validation); I will run the sessions; you prepare the script and the metric sheet.
9. Follow-ups: fix or schedule into P2.

## Output
`docs/reports/P1-gate.md` with results, evidence links, risk register, and a go/no-go for pilots. After my OK: tag `v0.2.0`, then start P2 using `docs/prompts/P2/README.md`.
