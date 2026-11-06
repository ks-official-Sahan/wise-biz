# Runbook: free hosting (Render for the server, Vercel for the console), for beginners

Decision: ADR 0024. Use this path while nothing earns money and Google Cloud is not available. It costs nothing, and it has limits you should know first.

What you get, and what you give up:

| | Free path | Google Cloud path (`first-release.md` parts 3 to 6) |
|---|---|---|
| Cost | 0 | a few dollars a month at least |
| Server | API and background workers in one container (Render free, 512 MB) | api, workers, realtime as separate services |
| Sleep | The server sleeps after about 15 minutes with no request; the first request after takes up to a minute. The keep-alive workflow below pings it every 10 minutes, so it stays awake | no sleep |
| Live updates | No realtime service: terminals poll for changes instead of getting a push | live hints in under a second |
| Migrations | You run them from your PC before each release | automatic job |

Good for: building, demos, a pilot with one or two shops. Not for: many shops at once, or a business that cannot tolerate a slow first request. Move to the Google Cloud path or a small paid server when there is revenue.

## 0. What you need first

- The services from `first-release.md` part 2 done: Neon (database), Redis, Cloudflare R2, email. Their values are in your `.env`.
- A GitHub account (you have it), and the repository pushed.
- Accounts to create now, both free: **Render** (render.com, sign in with GitHub) and **Vercel** (vercel.com, sign in with GitHub, choose the **Hobby** plan).

## 1. Prepare the database (from your PC, every release)

The free server has no migration step, so you run it yourself. In PowerShell in the repository folder, with the migrator line of your staging URLs file:

```powershell
$line = Get-Content "$HOME\wise-biz-staging-database-urls.txt" | Where-Object { $_ -like "DATABASE_MIGRATOR_URL=*" }
$env:DATABASE_MIGRATOR_URL = $line.Substring("DATABASE_MIGRATOR_URL=".Length)
pnpm db:migrate
pnpm db:rls-check
```

Both must pass before you deploy a new version. (They already did for staging.)

## 2. The server on Render

1. Where: dashboard.render.com, **New**, **Blueprint**. Connect your GitHub account, pick the `wise-biz` repository, branch `master`. Render reads `render.yaml` and shows one service, `wise-biz-server`, plan **Free**, region **Singapore** (the same area as the Neon database).
2. Render asks for every value marked `sync: false`. Fill them from your `.env` and your Neon URLs file:
   - `AUTH_SECRET`, `INVITE_SECRET`, `PIN_PEPPER`: random strings, 48 characters or more. Make each with `openssl rand -base64 48` (Git Bash) and paste. Never reuse the dev ones.
   - `DATABASE_URL`, `DATABASE_IDENTITY_URL`, `DATABASE_WORKER_URL`, `DATABASE_CHAINER_URL`: the lines of the Neon URLs file (not the migrator one).
   - `REDIS_URL`, the `STORAGE_*` values, the mail values (`MAIL_FROM`, `EMAIL_PROVIDER`, the provider keys): from your `.env`.
   - `CONSOLE_URL`, `AUTH_URL`, `CORS_ORIGINS`: your console address from step 3. You do not have it yet: type `https://placeholder.invalid` now and fix it after step 3 (Render, the service, **Environment**).
   - `AUTH_RP_ID`: the console host name only, for example `wise-biz-console.vercel.app` (no `https://`). Changing it later invalidates every passkey.
   - Leave the optional ones empty.
3. Click **Apply**. The first build takes several minutes. When it shows **Live**, open `https://<service>.onrender.com/health`: it must answer ok. Copy the service address.
4. Where: the service, **Settings**, **Auto-Deploy**: it is off on purpose; deploy by **Manual Deploy**, **Deploy latest commit**, after you ran the migrations (step 1).

If the service crashes at start, **Logs** names the missing or bad variable (it never prints the value). Memory: the free plan has 512 MB. If **Logs** shows the process killed for memory, lower `DATABASE_POOL_MAX` (for example to `5`) and redeploy; if it keeps happening, the free path is too small for your load.

## 3. The console on Vercel

1. Where: vercel.com, **Add New**, **Project**, import the `wise-biz` repository.
2. **Root Directory**: `apps/console`. Framework: Next.js (detected). Leave the build and install commands on their defaults (Vercel runs `pnpm install` for the workspace).
3. **Environment Variables**: add `API_ORIGIN` = the Render address from step 2 (for example `https://wise-biz-server.onrender.com`, no trailing slash). The console sends every `/v1` request to it.
4. Optional, error reports: add `NEXT_PUBLIC_SENTRY_DSN` (a **Next.js** project's DSN from sentry.io, see `first-release.md` part 9) and `NEXT_PUBLIC_SENTRY_ENVIRONMENT` = `staging`. They must exist before the deploy, because the browser reads them at build time.
5. **Deploy**. When it finishes you get an address such as `https://wise-biz-console.vercel.app`. That is your console address.
6. Go back to Render, **Environment**, and set `CONSOLE_URL`, `AUTH_URL` and `CORS_ORIGINS` to that address, and `AUTH_RP_ID` to its host name. Save; Render redeploys.
7. Add the address to the R2 bucket CORS rule (`first-release.md` part 2a, step 4).

**Check:** open the console address, create the first account, check the verification email arrives, create a business. If sign-in fails with a network error, `API_ORIGIN` or `CORS_ORIGINS` is wrong.

## 4. Keep the server awake

Where: GitHub repository, Settings, Secrets and variables, Actions, **Variables**: add `SERVER_URL` = the Render address. The workflow **Keep the free server awake** then calls `/health` every 10 minutes. Check it under Actions, **Run workflow**. This works because the repository is public (Actions minutes are free); if you make it private, GitHub's free minutes run out and you should use a free external pinger instead (cron-job.org, one request every 10 minutes to `/health`).

## 5. Desktop and mobile, without paid certificates

- **Windows and Linux installers, unsigned.** In GitHub, Settings, Environments, `desktop-release`, add the variable `DESKTOP_UNSIGNED` = `true`, plus `WISE_BIZ_API_URL` (your console address) and `WISE_BIZ_UPDATE_URL` (any https folder where you will put the update files). Tag a release as in `first-release.md` part 7. macOS is skipped (a Mac cannot run an unsigned, unnotarized app). Windows shows a **SmartScreen** warning ("Windows protected your PC"): the user clicks **More info**, **Run anyway**. Do not let the installers auto-update from a host you do not control: without a signature, the update file is the only protection.
- **Android, no cost for testing.** `eas build --platform android --profile staging` (run in `apps/pos`) makes an installable APK on Expo's free build queue (slow, limited builds a month). Publishing to the Play Store needs a paid account; skip it for now.
- **iOS needs the paid Apple program.** Skip it for now.
- Set the app's API address in Expo: `eas env:set production --name EXPO_PUBLIC_API_URL --value https://<console address> --visibility plaintext --non-interactive` (and the same for `preview`).

## 6. Moving to Google Cloud later

Nothing here is thrown away: the image is the same recipe (`APP=server` instead of three services), the database, Redis, storage and email stay, and `first-release.md` parts 3 to 6 describe the rest.
