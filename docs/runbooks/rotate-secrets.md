# Runbook: rotate secrets

Rotate on a schedule (90 days) and immediately after any suspected leak or when a person with access leaves.

| Secret | Where used | How to rotate |
|---|---|---|
| `AUTH_SECRET` | session signing (api) | Add the new value, deploy, existing sessions end: tell staff to sign in again. Never reuse a dev value. |
| `INVITE_SECRET` | invite tokens (api, workers) | Rotate; pending invites become invalid, re-send them. |
| `DATABASE_*_URL` passwords | api, workers, migrations | `ALTER ROLE ... PASSWORD`, update the secret store, roll api then workers (connections reconnect on restart). One role at a time. |
| `REDIS_PASSWORD` / `REDIS_URL` | api, realtime, workers | Change on the server, update env, roll api, realtime, workers. Realtime hints pause briefly; terminals fall back to polling. |
| `STORAGE_*` keys | object store | Create a new key pair, deploy, delete the old pair. |
| Backup `age` key | backups | Generate a new pair, update `BACKUP_AGE_RECIPIENT`, keep the old private key until the last backup encrypted with it ages out. |
| Device keys | terminals | Not a secret rotation: revoke the device (`revoke-device-fleet.md`) and enroll again. |

After rotating, confirm `/v1/ready` and the worker logs, and record the date here.
