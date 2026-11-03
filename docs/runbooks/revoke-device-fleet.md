# Runbook: revoke a device (or a whole fleet)

Use when a terminal is lost or stolen, or a key may be exposed. A revoked device is refused by the API immediately (401 `DEVICE_REVOKED`), and a terminal that learns it erases its local data on its next contact.

## One terminal
Console → Terminals → the device → **Revoke** (or **Blacklist** for a stolen one: its key can never be enrolled again). Both are audited and emit `devices.device.status_changed`.

## Many terminals
1. List them: `GET /v1/devices` (needs `devices:read`); filter by `branchId` and `status: active` in the response.
2. Revoke each: `PATCH /v1/devices/<id>` with `{"status":"revoked"}` (or `"blacklisted"`) and an `Idempotency-Key` (needs `devices:manage`). For a whole branch, loop over the list; every call is idempotent, so a partial run is safe to repeat.
3. Enroll replacements with new one-time codes (Console → Terminals → Add a terminal).

## Afterwards
- Review Audit for `devices.*` entries and for sales from the device after the loss time (Console → Sales, filter by terminal; "needs review" flags).
- A lost terminal may hold unsynced sales. They stay in its local store and are refused on sync once revoked: decide with the owner whether to recover them from the device before wiping it.
