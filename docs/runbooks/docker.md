# Runbook: run the whole product in Docker (test now, deploy to a VPS later)

One set of container images runs the complete product: database, cache, file storage, mail, API, background workers, realtime, the operator console and the web server in front. You can test everything on your own PC with it today, and the same files run on a rented server (a VPS) when you can afford one. Nothing here deploys to a cloud account.

What runs (`infra/docker/compose.stack.yaml`):

| Container | What it is | Reachable from your PC |
|---|---|---|
| `nginx` | The one front door. Sends `/v1/*` to the API, live updates to realtime, everything else to the console | http://localhost:8080 |
| `console` | The operator web app | through nginx |
| `api` | The HTTP API | through nginx at `/v1/*` |
| `workers` | Background jobs (mail, exports, reports, audit chain) | no |
| `realtime` | Live update stream for terminals | through nginx |
| `postgres` | The database (Postgres 18 with pgvector), data kept in a Docker volume | no |
| `redis` | Cache and live-update channel | no |
| `storage` | Object storage (RustFS, S3 compatible) for imports, exports and images | console http://localhost:19001 |
| `mailpit` | A mail sink: every mail the product sends lands here, nothing leaves your PC | http://localhost:18025 |
| `db-roles`, `migrate`, `storage-init` | One-time jobs: create the five database roles, apply the migrations, create the bucket | no |

The database, Redis and storage sit on an internal Docker network with no route to the internet and no published port (the two loopback ports for storage and Mailpit are for you to look at things, and the VPS file closes them).

## Part A. Test everything on your PC

### A1. What you need

- Docker Desktop, running (the whale icon says "Engine running"). Give it about 6 GB of memory (Settings, Resources). The stack itself uses about 3.5 GB at its limits, and it is fine to leave other Docker containers off while you test.
- Node 24 (the project's `.nvmrc`). The stack scripts are plain Node: no `pnpm install` is needed to run them.
- Free host ports: 8080 (the product), 18025 (Mailpit), 19000 and 19001 (storage). They differ from the development infrastructure (`pnpm infra:up` uses 5433, 6379, 9001, 8025 and 1025), so both can run side by side.

### A2. Create the secrets

```bash
pnpm stack:env
```

This writes `.env.stack` and one file per service (`.env.stack.api`, `.env.stack.workers`, `.env.stack.realtime`, `.env.stack.console`, `.env.stack.migrate`, `.env.stack.db-roles`) in the project folder, with fresh random passwords and keys. It prints only the file names. The files are ignored by git and by Docker builds, so no secret ends up in the repository or in an image. It refuses to overwrite existing files unless you add `--force` (see "Start from zero" below: new passwords do not match an existing database volume).

### A3. Build and start

```bash
pnpm stack:up
```

This builds the four images (api, workers, realtime, console) and starts everything in the right order: database, roles, migrations, then the services, then nginx. It waits until every service reports healthy. When it prints each container as `Healthy` (and the three one-time jobs as `Exited`), the product is running.

The first build downloads the dependencies from the npm registry and can take 20 minutes or more on a slow connection. The dependency download is its own layer, built from the lockfile alone: a later build that changes only source code reuses it (measured: with one source file changed, the dependency step took 14 seconds instead of 16 minutes), and only a change to `pnpm-lock.yaml` downloads again.

### A4. Look around

- http://localhost:8080 opens the console. Create an account: the verification link arrives in Mailpit at http://localhost:18025 (open the mail, click the link).
- http://localhost:19001 is the storage console (the access key and secret are in `.env.stack`: `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`).
- See the containers: `docker compose -f infra/docker/compose.stack.yaml --env-file .env.stack ps`.

### A5. Run the automatic end-to-end check

```bash
pnpm stack:smoke
```

It drives the real owner journey over HTTP through nginx, the same way a browser would: the API answers, the console sign-in page loads, sign up with the mailed verification link, create a business, create a product, read it back, invite a member and see the mail arrive in Mailpit, and confirm a second business cannot read the first one's product (it must answer 404). It prints one line per step and `all 8 checks passed`, or names the step that failed. It takes about a minute, longer if the API is still starting.

### A6. Daily commands

| Do this | Command |
|---|---|
| Watch the logs of everything | `pnpm stack:logs` (Ctrl+C stops watching, not the stack) |
| Stop, keep all data | `pnpm stack:down` |
| Start again, keep data | `pnpm stack:up` |
| Rebuild after changing code | `pnpm stack:up` (it rebuilds what changed) |
| Start from zero (deletes the database, files and Redis data) | `pnpm stack:reset`, then `pnpm stack:env --force`, then `pnpm stack:up` |

### A7. When something is wrong

| Symptom | Likely cause and fix |
|---|---|
| `port is already allocated` for 8080, 18025, 19000 or 19001 | Another program holds that port. Stop it, or change the left-hand number of the `ports:` line in `infra/docker/compose.stack.yaml` |
| `run pnpm stack:env first` | The `.env.stack` files do not exist yet: run `pnpm stack:env` |
| `stack:env` says "Refusing to overwrite" | Files from an earlier run exist. Use `--force` only together with `pnpm stack:reset`: a new password does not fit the old database volume |
| The `migrate` job fails | Read its log: `docker compose -f infra/docker/compose.stack.yaml --env-file .env.stack logs migrate`. A password error means the files and the volume are out of step: reset (A6) |
| A service stays `unhealthy` | `docker compose -f infra/docker/compose.stack.yaml --env-file .env.stack logs <service>`: the log names the missing or bad variable and never prints its value |
| The smoke test fails at the first step | The API is not up yet or crashed: check `ps` and the `api` log |
| The smoke test fails with a 429 | Rate limits: wait a minute and run it again |
| Everything is very slow, or Docker stops containers | Not enough memory: raise Docker Desktop's memory limit, and stop the development infrastructure (`pnpm infra:down`) while you test the stack |
| The first build takes very long | The dependencies are downloaded from the npm registry over your connection (16 to 20 minutes on a slow link). It happens once per lockfile change: other builds reuse the dependency layer |

## Part B. The same images on a VPS

Status: the files are written and the compose configuration validates (only ports 80 and 443 are published), but a real VPS run has not been done yet. Do the first one on a cheap server, keep it private, and treat anything that differs from this part as a bug in this runbook: fix the runbook.

### B1. Choose a server

2 vCPU, 4 GB of memory and 40 GB of disk is the minimum for the whole stack on one machine (database included). Any provider that gives you a Linux VPS with root and a public IP works. Use Ubuntu 24.04 LTS.

### B2. Prepare the server (once)

1. Point a DNS name (for example `app.yourdomain.com`) at the server's IP address (an `A` record).
2. Log in with SSH and install Docker Engine with the Compose plugin (follow docs.docker.com/engine/install/ubuntu).
3. Firewall: allow only 22 (SSH), 80 and 443. For example `ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable`. Docker publishes ports around `ufw`, so the compose files publish nothing else: check with `docker ps` that no database, Redis or storage port is bound to the public address.
4. Install Git, clone the repository, and check out a release tag: `git clone <repo> && cd wise-biz && git checkout vX.Y.Z`.
5. Install Node 24 (for the two helper scripts only).

### B3. Certificate

Get a certificate for your DNS name, for example with certbot (`certbot certonly --standalone -d app.yourdomain.com`, run while port 80 is free, before the first start). Copy `fullchain.pem` and `privkey.pem` into `infra/docker/tls/` (create it; it is not committed). Renew every 60 days and restart nginx after each renewal.

### B4. Secrets for the server

Create new secrets on the server with your public address; never copy the files from your PC:

```bash
node scripts/stack-env.mts --public-url=https://app.yourdomain.com
```

Then edit the generated files for a real server:

- `.env.stack.api`, `.env.stack.workers`, `.env.stack.realtime`: set `NODE_ENV=production`.
- Mail: Mailpit only catches mail. Set a real provider in `.env.stack.api` and `.env.stack.workers`: `EMAIL_PROVIDER=resend` with `RESEND_API_KEY` and `RESEND_EMAIL_SENDER_EMAIL`, or the Brevo keys, and remove the `MAIL_SMTP_HOST` and `MAIL_SMTP_PORT` lines (`docs/runbooks/first-release.md` part 2b explains each key, with the free tiers). In production the mailer refuses to start without a real provider.
- Optional: Sentry (`SENTRY_DSN`), and `CLOUDFLARE_ANALYTICS_TOKEN` with `R2_PERIOD_ANCHOR_DAY` only if you store files in Cloudflare R2 instead of the local storage container.
- Keep a copy of `.env.stack*` in your password manager. If you lose the database password file the data cannot be opened by the services (the volume keeps the old passwords).

### B5. Start

```bash
docker compose -f infra/docker/compose.stack.yaml -f infra/docker/compose.vps.yaml --env-file .env.stack up -d --build --wait --wait-timeout 1800
```

`compose.vps.yaml` adds the TLS web server configuration, publishes only ports 80 and 443 and closes the storage and Mailpit ports. Open `https://app.yourdomain.com`, create the first account, and run `node scripts/stack-smoke.mts` from your PC with `STACK_URL=https://app.yourdomain.com` only if you keep Mailpit reachable (the smoke test reads the mail sink). On a production server, prove the journey by hand instead: sign up, read the verification mail in your real inbox, create a business.

### B6. Update to a new release

Migrations run first, then the services roll (the `migrate` job completes before `api`, `workers` and `realtime` start).

```bash
git fetch --tags && git checkout vX.Y.Z
WB_VERSION=vX.Y.Z docker compose -f infra/docker/compose.stack.yaml -f infra/docker/compose.vps.yaml --env-file .env.stack up -d --build --wait --wait-timeout 1800
```

Migrations only add things while old code can still run, so the previous release keeps working if you go back. To go back, check out the previous tag and run the same command with the previous `WB_VERSION` (`docs/runbooks/rollback.md`, which also says what not to do after a failed migration).

### B7. Backups

The database volume is the only copy of your data. Take encrypted logical backups to an object store (Cloudflare R2 has a free tier) with `infra/backup/backup.sh`, on a schedule (cron on the VPS), and prove a restore into a fresh database once before real data arrives: `docs/runbooks/restore.md` has the steps, the role the backup needs and the drill table. A snapshot of the VPS disk from your provider is a second layer, not a replacement.

### B8. What not to do

- Never publish the Postgres, Redis or storage ports. The compose files keep them on the internal network on purpose.
- Never reuse the secrets generated on your PC, and never commit `.env.stack*`.
- Never run the development setup (`infra/docker/postgres/init`) against a server: it makes roles whose password is their name.
- Do not skip the restore drill.
- Do not leave Mailpit on a public server.

### B9. Hosted database instead of the local container

If you later move the database to a managed service (Neon), use `infra/docker/compose.prod.yaml` instead of the stack file: it has no database or storage container and takes the connection strings from `.env.prod` (`docs/runbooks/deploy.md` and `docs/runbooks/neon.md`). The images are the same.
