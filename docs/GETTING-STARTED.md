# Getting started: what wise-biz is, where things are, how to run it, and what you do next

For the owner. No prior knowledge of the code needed. If a word is new, `CONTEXT.md` explains the domain words (sale, batch, shift, tenant).

## 1. What wise-biz is

A point-of-sale (POS) system for shops, sold to many shops at once (each shop is a **business**, also called a **tenant**, and can never see another's data).

- **Cashiers** sell on a **terminal**: the POS app on an Android or iOS phone or tablet, a Windows, Mac or Linux PC (the desktop app), or a browser. A terminal keeps working with no internet (it stores sales on the device and sends them later).
- **Owners and managers** run the shop from the **console**, a website: products, prices, stock, terminals, sales, shifts, reports, people and roles, approvals.
- Behind both sits the **API** (a server), plus background **workers** (emails, reports, exports, stock alerts), a **realtime** service (live updates) and a Postgres database (on Neon).

## 2. The pieces and where they live in the repository

| Folder | What it is | Who uses it |
|---|---|---|
| `apps/console` | The console website (Next.js) | owners, managers |
| `apps/pos` | The POS app (Expo / React Native: phone, tablet, web) | cashiers |
| `apps/desktop` | The same POS app wrapped as a Windows/Mac/Linux program (Electron), with printer, cash drawer, scale | cashiers |
| `apps/api` | The server API (`/v1/...`) | console, POS apps |
| `apps/workers` | Background jobs: sync relay, emails and push notifications, reports, exports, alerts | the system |
| `apps/realtime` | Live updates to the console and terminals | the system |
| `apps/edge` | A small Cloudflare Worker in front of the API (rate limit, short links) | optional, later |
| `modules/*` | The business logic, one folder per area: `catalog`, `inventory`, `sales`, `tenancy`, `identity`, `devices`, `reporting`, `notifications`, ... | the API and workers |
| `packages/*` | Shared libraries: money, ids, sync engine, signatures, UI kit, theme, mailer, env, db | everything |
| `infra/` | Docker setups for local use and for production, nginx, backups, Neon role script | you, the deploy |
| `docs/` | Plans, decisions (`docs/adr`), runbooks (`docs/runbooks`), design rules | everyone |
| `.github/workflows` | The automatic build, test, release and deploy steps | GitHub |

Where to read more: `PRODUCT.md` (what and for whom), `ARCHITECTURE.md` (how it is built), `docs/ROADMAP.md` (phases), `docs/prompts/PROGRESS.md` (what is done and what is open).

## 3. Run it on your own computer

Needs: Windows 11 with **Docker Desktop** running, **Node.js 24** and **Git**. (I wrote these steps from the repository's README, `.env.example` and scripts; I have not run the whole sequence on your machine, so tell me the first error you meet.)

In PowerShell, from the repository folder:

```powershell
corepack enable
pnpm i                         # installs everything (a few minutes the first time)
copy .env.example .env         # local settings; the defaults match the Docker setup
```

Open `.env` and set `DEMO_PASSWORD=` to a password of 12 or more characters (the demo users get it). Then:

```powershell
pnpm infra:up                  # starts Postgres, Redis, object storage and a fake mailbox in Docker
pnpm db:migrate                # creates all tables
pnpm db:seed                   # creates the "Demo Store" business and demo users
```

Then start the four services, each in its own terminal tab:

```powershell
pnpm -F @wise-biz/api dev        # the API, http://localhost:3001
pnpm -F @wise-biz/workers dev    # background jobs
pnpm -F @wise-biz/realtime dev   # live updates
pnpm -F @wise-biz/console dev    # the console, http://localhost:3000
```

Open **http://localhost:3000** and sign in as `owner@demo.wise-biz.local` with the `DEMO_PASSWORD` you set. The demo seed also creates one user per other role (the addresses are `<role>@demo.wise-biz.local`; the Roles page lists the roles). Emails the system sends (verification, invitations) land in the fake mailbox at **http://localhost:8025**.

The whole product in containers (no development tools needed, nothing is deployed): `pnpm stack:env`, `pnpm stack:up`, `pnpm stack:smoke`, then open http://localhost:8080. Details and the VPS path: `docs/runbooks/docker.md`.

The POS app in a browser (a quick way to see the cashier side): in a new tab set `$env:EXPO_PUBLIC_API_URL = "http://localhost:3001"`, add `http://localhost:8081` to `CORS_ORIGINS` in `.env` (restart the API), then run `pnpm -F @wise-biz/pos web`. For a phone you need the Expo Go or a development build (`docs/runbooks/first-release.md`, part 8).

Stop everything with `pnpm infra:down`. Wipe the local data with `pnpm infra:reset`.

Checks developers run: `pnpm check` (lint, types, tests).

## 4. The user flows (what a shop does)

1. **Sign up and set up the business.** Someone creates an account at the console, verifies the email, creates a business and goes through the onboarding steps (currency, tax, branch).
2. **Add products.** Products page: add one by one, or **Import** a CSV (map the columns, preview, import).
3. **Receive stock.** Stock page: receive a delivery into a branch location. Stock is a ledger: every change is a movement, never an edit of a number.
4. **Enrol a terminal.** Console, Terminals, create an **enrolment code** (shown as text and a QR code). On the POS app (phone, PC or browser) choose "enrol" and enter the code. The terminal appears in the console as active as soon as the code is used (the code lasts 15 minutes). A code that was made and never used shows under **Approvals** as an unfinished enrolment, where you can cancel it.
5. **Sell.** On the terminal: a cashier signs in with a PIN, scans or searches products, takes payment (cash with change, card, split), and prints or shows a receipt. This works offline. The first sale of the day opens a **shift**.
6. **Review.** Console, Sales: every sale, flagged ones (price difference, override, cash over or short) also show in **Approvals**. Returns and voids are on the sale page.
7. **Close the shift.** The cashier counts the drawer; the console shows the **Z report** (expected cash against counted).
8. **Reports and alerts.** Reports page: sales, stock, expiring batches, exports to CSV. The system emails or pushes low-stock and silent-terminal alerts and a daily digest (Notifications page sets who gets what).

## 5. What you need to do now, in order

You already did the first three. Details for each are in `docs/runbooks/first-release.md`, which now starts with a short checklist.

1. ✅ Neon project `Wise-Biz`, database `wise_biz`, a read replica and a `staging` branch (all of `docs/runbooks/neon.md` parts 1 to 3).
2. ✅ Tag `v0.2.1` (done: it makes the container images and the app builds start).
3. **Create the database roles** on Neon (`docs/runbooks/neon.md`, part 4): one command, first for the `staging` branch, in plain steps, about five minutes.
4. **Rotate the credentials you pasted in chat** (see the warning below).
5. Create the other accounts the server needs: Redis, object storage, email (`first-release.md`, part 2).
6. Create the Google Cloud setup and the secrets (parts 3 and 4), then the GitHub environments (part 5).
7. Run the first deploy to staging (part 6) and click through the flows above on the staging console.
8. Desktop and mobile release setup (parts 7 and 8) can wait until the server works on staging.
9. The P1-16 checks with real devices (part 10).

## 6. Warning: credentials in chat

The Neon owner password, the storage keys, the AI gateway token and the realtime secret were pasted into a chat. Treat them as leaked: in the Neon console reset the `neondb_owner` password and regenerate the storage keys and tokens, and use the new values from then on. Never paste a connection string with a password into a chat, an issue or a commit.

The "Set up this app on Neon" prompt (it runs `neon init` and `neon deploy` and adds Neon Auth, AI Gateway, Functions and Realtime) is **not** for this project. wise-biz uses only Neon's Postgres; sign-in, storage, realtime and everything else are built in or use the services in `first-release.md`. Do not run that prompt: it would add things the architecture does not use.
