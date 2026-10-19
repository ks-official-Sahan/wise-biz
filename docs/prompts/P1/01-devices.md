# P1-01 · Devices: enrollment, signing, PIN

Effort: **H** · Needs: P0-12 · Gate: confirm plan
Read: `docs/architecture/security.md` (Devices, Request and transaction signing, Identity: PIN rules), `docs/modules.md` (devices), `docs/architecture/api-conventions.md` (Headers)
Libraries: `@wise-biz/crypto`, RFC 9421 HTTP Message Signatures + RFC 9530 `Content-Digest`, Argon2id for Node (e.g. `@node-rs/argon2`), Redis (nonces)
Skills: `ecc:security-review`, `cybersecurity`, `ecc:api-design`

## Goal
Only approved terminals can sell. Every terminal request is signed and replay-proof, operators unlock a terminal with a quick PIN, and a lost device is cut off on its next request.

## Scope
1. `modules/devices`: tables `devices`, `device_keys`, `device_heartbeats` (partitioned or pruned at 90 days), `device_events`; statuses `pending | active | suspended | revoked | blacklisted`; RLS.
2. Enrollment: device generates an Ed25519 keypair → `POST /v1/devices/enroll` with public key, platform, app version → returns a short-lived enrollment code + QR payload → owner approves in console (`approveDevice` with branch + name) → device polls until active. Codes are rate-limited.
3. **`@wise-biz/http-signatures`** (universal): client `signRequest` and server `verifyRequest` per RFC 9421 over `@method`, `@path`, `content-digest`, `x-wb-timestamp`, `x-wb-nonce`, `x-wb-device-id`; ≤ 5 min skew; replayed nonces rejected via Redis `SET NX` with TTL.
4. Middleware: `requireDevice()` (valid signature + active) and `requireTerminal()` (active + assigned branch) for sales and sync routes; revoked → 401 with a `wipe` flag.
5. Heartbeat `POST /v1/devices/heartbeat`: battery, app version, unsynced count, oldest unsynced at, last operator, connection type; updates `last_seen_at`; missed-heartbeat job emits `devices.heartbeat.missed`.
6. **PIN**: `operator_pins` (Argon2id + server pepper), unique per tenant, 5 failures → lockout (supervisor reset, audited); `pinLogin` returns a short operator session bound to the device key (every request is still device-signed).
7. **Offline PIN verifier** for the policy snapshot: a separate low-cost verifier hash (parameters tuned to ≤ 150 ms on a low-end Android) shipped inside the signed snapshot, rotated on PIN change. Document parameters and trade-off in security.md.
8. Events: `devices.device.enrolled|approved|suspended|revoked`, `devices.heartbeat.missed`.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | RFC 9421 signature base construction + any vetted implementation; Argon2 library for current Node LTS |
| 2 | wb-builder (sonnet) | `packages/http-signatures/**` | Item 3 with RFC examples as tests |
| 3 | wb-db (sonnet) | `modules/devices/migrations/**` | Item 1 |
| 4 | wb-builder (sonnet) | `modules/devices/src/**`, `apps/api/src/kernel/device/**` | Items 2, 4–8 |
| 5 | wb-tester (haiku) | tests | Acceptance list |

## Acceptance
- Unsigned, wrong-key, tampered-body, replayed-nonce, and skewed requests are rejected (one test each).
- Revoked device: next request rejected with the wipe flag.
- Suspended device user can still use the console (by role), but `requireTerminal` routes reject the device.
- PIN lockout after 5 tries; supervisor reset audited.
- Signature verification p95 < 2 ms (bench).

## Review
`ecc:security-reviewer`, `ecc:database-reviewer`
