# Runbook: first release (accounts, secrets, first deploy, desktop and mobile, Sentry)

The one-time setup that only the owner can do: accounts, keys, certificates and secrets. Everything in the repository (workflows, Dockerfiles, env schemas) is already written; this runbook says what to create outside it and where each value goes. Do the parts in order. Each part ends with a check, so a mistake shows up there and not in the middle of a release.

Conventions: `<ENV>` is `staging` or `production`. Do `staging` first, end to end, then repeat for `production`. Replace `OWNER/REPO` with `ks-official-Sahan/wise-biz`. Never paste a secret into a chat, an issue, a commit or a workflow log. Generate values with `openssl rand -base64 48` and put them straight into the secret store.

**No Google Cloud account?** Parts 3 to 6 below use Google Cloud. If you cannot create a billing account, or want to pay nothing until there is revenue, follow `docs/runbooks/free-hosting.md` for parts 3 to 6 instead (Render for the server, Vercel for the console), then continue here at part 7.

## The order, in one table

Read this first. Each line says **where** you do it, **what** you do and **when**. Finish a line before the next. Everything about the application itself (what it does, how to run it, what is in which folder) is in `docs/GETTING-STARTED.md`.

| # | Where | What | When | Part below |
|---|---|---|---|---|
| 1 | Neon console, then PowerShell on your PC | Project, the two branches, settings, the role script and the migration check: follow `docs/runbooks/neon.md` start to end | first | 1 and `neon.md` |
| 2 | Upstash (done), Cloudflare R2, Resend websites | Redis (done), two R2 buckets with keys and a usage token, an email sender | after 1 | 2 |
| 3 | Google Cloud console and a terminal with `gcloud` | Project, registry, service accounts, workload identity | after 2 | 3 |
| 4 | A terminal with `gcloud` | Put every setting into Secret Manager | after 3 | 4 |
| 5 | GitHub, repository Settings, Environments | `staging` and `production` with their variables | after 4 | 5 |
| 6 | GitHub, Actions | Tag (done for `v0.2.1`), then run the Deploy workflow for staging, then click through the console | after 5 | 6 |
| 7 | Windows PC, Apple, Microsoft accounts | Desktop installers and signing | after 6 works | 7 |
| 8 | Expo, Apple, Google Play | Mobile apps | after 6 works | 8 |
| 9 | sentry.io | Error reports | any time after 6 | 9 |
| 10 | Real devices and a staging shop | The P1-16 checks before real customers | last | 10 |

You can stop after line 6 and use the staging console in a browser; lines 7 to 10 are for when you want installers, phones and customers.

What you need to hold in the end:

| Where | What |
|---|---|
| Neon | one project `Wise-Biz` with two branches, `production` and `staging` (they never share data), database `wise_biz` in each, five roles per branch, one read replica for production (optional) |
| Google Cloud | one project, Cloud Run, Artifact Registry, Secret Manager, a deploy service account with workload identity |
| Redis | one managed Redis (Upstash or similar) per environment |
| Object storage | Cloudflare R2: one private bucket per environment, a key per bucket, a read-only usage token (part 2a); caps in ADR 0023 |
| Email | one sending domain at Resend (or an SMTP relay) |
| GitHub | environments `staging`, `production`, `desktop-release`, `mobile-release` with the variables and secrets below |
| Apple | Developer Program membership (macOS notarization, iOS builds) |
| Google Play | Play Console account (Android builds) |
| Microsoft | a code signing certificate (Windows installer) |
| Expo | an account and an access token |
| Sentry | an organization and projects (optional but recommended) |

## 1. Neon (database)

Follow `docs/runbooks/neon.md` in full. It covers the project, the roles (one command: `pnpm -F @wise-biz/db provision-neon <env>`), which connection string goes in which variable (pooled or direct host) and the read replica. Keep the four connection strings; they become the Secret Manager entries `DATABASE_URL`, `DATABASE_IDENTITY_URL`, `DATABASE_WORKER_URL`, `DATABASE_CHAINER_URL` and `DATABASE_MIGRATOR_URL` in part 4. Check the role of each URL against the table in `neon.md` before you save it.

Check: from your machine, with the migrator URL in `DATABASE_MIGRATOR_URL`: `pnpm db:migrate`, then `pnpm db:rls-check`. Both must pass. Then confirm `select rolbypassrls from pg_roles where rolname in ('wb_app','wb_worker')` is false for both. Do this against the staging database first.

## 2. Redis, object storage (Cloudflare R2), email

These are the three services the API and workers need besides Postgres.

**Redis: done.** Keep the `rediss://` URL; it becomes `REDIS_URL` in part 4. Use one Redis per environment (a staging one and a production one) so a test never touches real data.

### 2a. Cloudflare R2 (object storage)

What it holds: CSV imports, report exports, product images. Why R2: no download fees, and a free tier of 10 GB, 1 million writes (Class A) and 10 million reads (Class B) every month. wise-biz refuses to go past 9.5 GB, 900,000 writes and 9,500,000 reads, so your bill stays at zero (`docs/adr/0023-object-storage-stays-inside-the-r2-free-tier.md`).

Know this first:
- The free tier is **per Cloudflare account**, not per bucket. Staging and production buckets share the same 10 GB, so the caps are shared too.
- Only the **Standard** storage class has a free tier. Never choose Infrequent Access.
- Your billing period is November 6 to December 6, then December 6 to January 6, and so on. That is why you set `R2_PERIOD_ANCHOR_DAY=6` (below). Operation counts start again at zero on the 6th. Stored bytes do not reset; they go down only when files are deleted.
- Cloudflare has no hard spending cap. The cap is wise-biz's own gate. It stops wise-biz's uploads and downloads; it cannot stop something you upload by hand in the Cloudflare dashboard.

**Step 1. Find your account id.** Where: dash.cloudflare.com, signed in. The **Account ID** (32 letters and digits) is in the address bar after `dash.cloudflare.com/`, and in the right-hand column of the account home page. Copy it.

**Step 2. Create the staging bucket.** Where: left menu **Storage & databases**, **R2 object storage**, **Overview**. Click **Create bucket**.
- Bucket name: `wise-biz-staging` (lowercase, no spaces).
- Location: **Asia-Pacific (APAC)**, near Singapore. (Leave Automatic if APAC is not offered.)
- Default storage class: **Standard**.
- Click **Create bucket**.

**Step 3. Create the production bucket** the same way, named `wise-biz-production`. Leave both **private**: do not turn on the public `r2.dev` URL or a custom domain. Files are handed out through short-lived signed links.

**Step 4. Allow the console to upload straight to the bucket.** Where: R2 object storage, click the bucket, **Settings**, section **CORS Policy**, **Add CORS policy**. Paste this with your own console address (you can edit it after the first deploy, part 6):

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

Save. Do this on both buckets. Without `Content-Type` in `AllowedHeaders` the browser's CSV upload is refused.

**Step 5. Create the access keys the application uses.** Where: R2 object storage, **Overview**, on the right **API**, then **Manage API tokens** (or **Create API token**).
- Token name: `wise-biz-staging`.
- Permissions: **Object Read & Write**.
- Specify bucket(s): **Apply to specific buckets only**, tick `wise-biz-staging`.
- Leave the TTL on forever. Click **Create API Token**.
- The next page shows **Access Key ID**, **Secret Access Key** and the **endpoint** `https://<account-id>.r2.cloudflarestorage.com`. The secret is shown **once**. Copy all three into a private note now (never into a chat).

Repeat for production: token `wise-biz-production`, bucket `wise-biz-production`. Each environment gets its own token, so a leak in staging cannot read production files.

**Step 6. Create the usage token (this makes the cap exact).** Where: dash.cloudflare.com, profile icon at the top right, **My Profile**, **API Tokens**, **Create Token**, at the bottom **Create Custom Token** (**Get started**).
- Token name: `wise-biz-r2-usage`.
- Permissions: first box **Account**, second **Account Analytics**, third **Read**.
- Account Resources: **Include**, your account.
- **Continue to summary**, **Create Token**. Copy the token (shown once).

This token can only read numbers. It cannot read files or change anything.

**Step 7. Put the values where they belong.** In part 4 you set, per environment:

| Secret | Value |
|---|---|
| `STORAGE_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `STORAGE_REGION` | `auto` |
| `STORAGE_BUCKET` | `wise-biz-staging` (or `wise-biz-production`) |
| `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` | from step 5 |
| `CLOUDFLARE_ANALYTICS_TOKEN` | from step 6 (the same token for both environments is fine) |
| `R2_PERIOD_ANCHOR_DAY` | `6` |

Optional: `R2_LIMIT_STORAGE_BYTES`, `R2_LIMIT_CLASS_A`, `R2_LIMIT_CLASS_B` change the caps (defaults 9500000000, 900000, 9500000). Never raise them above the free tier.

**Step 8. The hourly usage check on GitHub.** Where: GitHub repository, Settings, Secrets and variables, Actions (repository level, not an environment, because the production environment waits for your approval and a scheduled run must not). On the **Variables** tab add `CLOUDFLARE_ACCOUNT_ID` (step 1) and `R2_PERIOD_ANCHOR_DAY` set to `6`; on the **Secrets** tab add `CLOUDFLARE_ANALYTICS_TOKEN` (step 6). The workflow **R2 usage** then runs every hour: it warns at 80% of a cap and fails at the cap, and GitHub emails you when a run fails. Run it now from Actions, **R2 usage**, **Run workflow**. Before any workflow step that writes to R2, run the same check with `pnpm -F @wise-biz/storage r2-usage`.

**What happens when a cap is reached.** The API answers 503 with the code `STORAGE_QUOTA_EXCEEDED`; uploads and downloads of files pause (selling, stock and reports keep working). The log says `object storage reached its monthly cap` and Sentry gets an event. It clears by itself when the period resets, or when you delete files (storage only). If a month really reaches the caps, see "Alternatives not taken now" in ADR 0023 (a second account, or Cloudinary for images).

**Check:** both buckets exist and are private; you hold, per environment, the endpoint, bucket, key id and secret; you hold the usage token and the account id; the **R2 usage** workflow ran and its summary shows three rows under the caps.

### 2b. Email (Brevo and Resend, both free)

Free plans: **Brevo** 300 mails a day, **Resend** 100 a day (3,000 a month). wise-biz can use both: with `EMAIL_PROVIDER=auto` it tries the Brevo API, then Resend, then Brevo SMTP, and moves to the next when one fails (bad key, no credits, daily limit). It also stops sending through a provider for the day when its own count reaches the free limit (`BREVO_DAILY_LIMIT`, `RESEND_DAILY_LIMIT`; counted per running instance, so it is a hint, not a guarantee; neither provider bills overage on a free plan, they refuse).

**Resend.** Where: resend.com, signed in. **Domains**, **Add Domain**, enter your sending domain, pick the region nearest you. Add the DNS records Resend lists (SPF, DKIM) at your domain's DNS page (on Cloudflare: the domain, **DNS**, **Records**, **Add record**, proxy **DNS only**). Click **Verify DNS Records** until it shows **Verified**. **API Keys**, **Create API Key**, permission **Sending access**. Values: `RESEND_API_KEY`, and `RESEND_EMAIL_SENDER_EMAIL` = an address on the verified domain.

**Brevo.** Where: app.brevo.com. **Senders, Domains & dedicated IPs**, add and verify your sender address (or domain). **SMTP & API**: the **API keys** tab gives `BREVO_API_KEY` (starts `xkeysib-`); the **SMTP** tab gives the host `smtp-relay.brevo.com`, port `587`, the login (`BREVO_EMAIL_HOST_USER`) and an SMTP key (`BREVO_EMAIL_HOST_PASSWORD`, starts `xsmtpsib-`). `BREVO_EMAIL_SENDER_USER` = the verified sender address. Brevo only delivers from a verified sender; mail from an unverified one is refused or lands in spam.

**Copies (CC and BCC).** `MAIL_CC_EMAILS` and `MAIL_BCC_EMAILS` (comma separated, up to 10 each) apply to every mail on every provider. Mail carries invite links, verification links and one-time codes, so by default (`MAIL_COPY_MODE=redacted`) copies arrive as a separate mail, sent to the sender address with all copy addresses hidden, with links and 6 to 8 digit codes removed. Set `MAIL_COPY_MODE=full` only if you accept that whoever reads the copy mailbox can use those links and codes; then CC and BCC are real headers on the one mail.

**Sender addresses.** `MAIL_FROM` is a plain address (`no-reply@yourdomain.com`, no display name). Each provider can have its own sender (`RESEND_EMAIL_SENDER_EMAIL`, `BREVO_EMAIL_SENDER_USER`); they fall back to `MAIL_FROM`. Production must not set `MAIL_SMTP_HOST` (that is the local Mailpit relay) unless you mean to use a relay.

**Check:** the Resend domain shows Verified; the Brevo sender is validated; send yourself one mail through each provider by setting `EMAIL_PROVIDER` to `resend`, `brevo-api` and `brevo-smtp` in turn locally.

## 3. Google Cloud (Cloud Run, Artifact Registry, Secret Manager, workload identity)

`deploy.yml` signs in with workload identity federation, so no long-lived key exists anywhere. Create one Google Cloud project per environment (or one for both with different secret prefixes; the secret names already carry `<ENV>`). Pick a region and use it everywhere. Use `asia-southeast1` (Singapore) to sit next to the Neon database in `ap-southeast-1`. Enable billing.

**Before the commands (first time only)**
1. **Create the project.** Where: console.cloud.google.com, signed in with your Google account. Top bar, the project picker, **New project**. Name `wise-biz-staging` (and later `wise-biz-production`). Click **Create**. Note the **Project ID** (it can differ from the name, for example `wise-biz-staging-123456`); the commands use the ID.
2. **Turn on billing.** Left menu **Billing**, **Link a billing account**, add a card. Cloud Run has a free allowance; you pay only past it. In **Billing**, **Budgets & alerts**, **Create budget**: amount 20 USD a month, alerts at 50% and 100%, so you hear about cost early.
3. **Install the `gcloud` tool on your PC.** Where: cloud.google.com/sdk/docs/install, **Windows**, download and run the installer, keep the defaults, tick **Run gcloud init** at the end.
4. **Sign in.** In a new PowerShell window: `gcloud auth login` (a browser opens; choose your account), then `gcloud config set project <your-project-id>`.
5. **The commands below use bash syntax.** On Windows open **Git Bash** (installed with Git) and run them there, or use **Cloud Shell**: in the Google Cloud console click the `>_` icon at the top right. Cloud Shell already has `gcloud` and is signed in, so steps 3 and 4 are not needed there.

```bash
PROJECT=<your-project-id>   REGION=<your-region>   REPO=wise-biz
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com

# Where the workflow copies the images to
gcloud artifacts repositories create $REPO --repository-format=docker --location=$REGION

# The account the workflow acts as, and the account the services run as
gcloud iam service-accounts create wb-deployer --display-name="wise-biz deployer"
gcloud iam service-accounts create wb-runtime  --display-name="wise-biz runtime"
DEPLOYER=wb-deployer@$PROJECT.iam.gserviceaccount.com
RUNTIME=wb-runtime@$PROJECT.iam.gserviceaccount.com

# Deployer: roll Cloud Run, push images, list secrets, act as the runtime account
for role in roles/run.admin roles/artifactregistry.writer roles/secretmanager.viewer; do
  gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$DEPLOYER" --role=$role
done
gcloud iam service-accounts add-iam-policy-binding $RUNTIME \
  --member="serviceAccount:$DEPLOYER" --role=roles/iam.serviceAccountUser

# Runtime: read the secrets
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$RUNTIME" --role=roles/secretmanager.secretAccessor
```

The workflow deploys with the project's default service account unless you tell it otherwise. To run the services as `wb-runtime`, add `--service-account wb-runtime@<your-project-id>.iam.gserviceaccount.com` (the account name written out, because the workflow defines no variable for it) to the `gcloud run deploy` lines and the `gcloud run jobs deploy` line in `deploy.yml`, one line per command, or grant `roles/secretmanager.secretAccessor` to the default Compute Engine account instead. Pick one before the first deploy.

Workload identity (lets only this repository act as the deployer):

```bash
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github --location=global \
  --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='OWNER/REPO'"

PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding $DEPLOYER \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/OWNER/REPO"

echo "GCP_WIF_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github"
echo "GCP_SERVICE_ACCOUNT=$DEPLOYER"
```

Keep the two printed values for part 5.

Check: `gcloud artifacts repositories list --location=$REGION` shows `wise-biz`, and `gcloud iam workload-identity-pools providers describe github --workload-identity-pool=github --location=global` prints the provider.

## 4. Secrets in Secret Manager

Every service setting lives in Secret Manager as `wb-<ENV>-<VARIABLE>`, including values that are not secret (URLs, the bucket name, the sender address). The deploy workflow reads the list of required variables from the code (`scripts/service-env.mts`) and stops before it changes anything if one is missing, so the message names what to add.

Decide the public addresses first, because several values refer to them:
- `CONSOLE_URL`: the console's public https URL (a custom domain such as `https://app.yourdomain`, or the Cloud Run URL for a first test).
- The API is reached by browsers through the console, which proxies `/v1` to the API (`API_ORIGIN`). So `AUTH_URL` is the console URL (the same value as `CONSOLE_URL`), and `CORS_ORIGINS` is that URL too.
- `AUTH_RP_ID` is the bare hostname of the console (`app.yourdomain`, no scheme, no port). Passkeys are bound to it: changing it later invalidates every registered passkey.

Create the secrets with two helpers. Run them in a private shell, and stop the shell from saving what you type, because the examples below put real values on the command line: `unset HISTFILE` first (or `set +o history` in bash). Values go in through stdin, so they never appear in a process list.

```bash
unset HISTFILE
ENV=${ENV:?set ENV to staging or production first}   # run the block again with the other value for the other environment
# put: sets a value you chose (a URL, a key from a provider); a second run adds a new version
put() { printf '%s' "$2" | gcloud secrets create "wb-$ENV-$1" --data-file=- 2>/dev/null \
        || printf '%s' "$2" | gcloud secrets versions add "wb-$ENV-$1" --data-file=-; }
# generate: makes a random key ONCE and never replaces it. A new value would invalidate sessions, invites and PIN hashes.
generate() { gcloud secrets describe "wb-$ENV-$1" >/dev/null 2>&1 \
        && echo "wb-$ENV-$1 exists, left as it is" \
        || openssl rand -base64 48 | tr -d '\n' | gcloud secrets create "wb-$ENV-$1" --data-file=-; }

generate AUTH_SECRET
generate INVITE_SECRET
generate PIN_PEPPER
generate REALTIME_TICKET_SECRET
put CONSOLE_URL        "https://app.example.com"
put AUTH_URL           "https://app.example.com"
put CORS_ORIGINS       "https://app.example.com"
put AUTH_RP_ID         "app.example.com"
put MAIL_FROM          "no-reply@example.com"
put EMAIL_PROVIDER     "auto"
put MAIL_CC_EMAILS     "<optional, comma separated>"
put MAIL_BCC_EMAILS    "<optional, comma separated>"
put RESEND_API_KEY     "<from Resend>"
put RESEND_EMAIL_SENDER_EMAIL "<verified address>"
put BREVO_API_KEY      "<from Brevo>"
put BREVO_EMAIL_SENDER_USER "<verified address>"
put BREVO_EMAIL_HOST   "smtp-relay.brevo.com"
put BREVO_EMAIL_HOST_USER "<Brevo SMTP login>"
put BREVO_EMAIL_HOST_PASSWORD "<Brevo SMTP key>"
put REDIS_URL          "<rediss:// URL from part 2>"
put STORAGE_BUCKET     "<bucket>"
put STORAGE_ACCESS_KEY_ID     "<key id>"
put STORAGE_SECRET_ACCESS_KEY "<secret>"
put STORAGE_ENDPOINT   "<R2 endpoint, omit on AWS>"
put STORAGE_REGION     "auto"
put CLOUDFLARE_ANALYTICS_TOKEN "<usage token from part 2a>"
put R2_PERIOD_ANCHOR_DAY "6"
put DATABASE_URL            "<wb_app pooled URL>"
put DATABASE_IDENTITY_URL   "<identity URL from neon.md>"
put DATABASE_WORKER_URL     "<wb_worker direct URL>"
put DATABASE_CHAINER_URL    "<chainer URL from neon.md>"
put DATABASE_MIGRATOR_URL   "<wb_migrator direct URL>"
put DATABASE_READ_URL       "<read replica URL, optional>"
put TRUST_PROXY_HOPS        "1"
```

Required per service (from the code; run `node scripts/service-env.mts <api|workers|realtime> --required` to see the current list):
- **api**: `AUTH_SECRET AUTH_URL CONSOLE_URL DATABASE_IDENTITY_URL DATABASE_URL INVITE_SECRET MAIL_FROM PIN_PEPPER REDIS_URL STORAGE_ACCESS_KEY_ID STORAGE_BUCKET STORAGE_SECRET_ACCESS_KEY`
- **workers**: `CONSOLE_URL DATABASE_CHAINER_URL DATABASE_WORKER_URL INVITE_SECRET MAIL_FROM STORAGE_ACCESS_KEY_ID STORAGE_BUCKET STORAGE_SECRET_ACCESS_KEY`
- **realtime**: `REDIS_URL`
- **migrate job**: `DATABASE_MIGRATOR_URL`

Also set the optional ones you want: `EMAIL_PROVIDER`, `EMAIL_PROVIDER_ORDER`, `MAIL_CC_EMAILS`, `MAIL_BCC_EMAILS`, `MAIL_COPY_MODE`, at least one provider (`RESEND_API_KEY`, `BREVO_API_KEY`, or the three `BREVO_EMAIL_HOST*` values), `DATABASE_READ_URL`, `AUTH_RP_ID`, `CORS_ORIGINS`, `TRUST_PROXY_HOPS`, `CLOUDFLARE_ANALYTICS_TOKEN`, `R2_PERIOD_ANCHOR_DAY`, `R2_LIMIT_*`, `REALTIME_TICKET_SECRET`, `REALTIME_URL`, `SENTRY_DSN` (part 8), `OTEL_EXPORTER_OTLP_ENDPOINT`. `TRUST_PROXY_HOPS` is how many proxies sit in front of the API; on Cloud Run behind the console proxy start at `1` and check in the first request log that the client address is a real client, not a Google address, before trusting rate limits. `INVITE_SECRET`, `AUTH_SECRET` and `PIN_PEPPER` must be at least 32 characters and must never change without following `docs/runbooks/rotate-secrets.md` (changing `PIN_PEPPER` invalidates every PIN).

Check: `gcloud secrets list --format='value(name)' | grep wb-staging-` lists them all.

## 5. GitHub environments for the deploy

In the repository: Settings, Environments, New environment: `staging`, then `production`. On `production` add yourself as a required reviewer and restrict it to the `master` branch and `v*.*.*` tags.

Variables on each environment (Settings, Environments, the environment, Environment variables):

| Variable | Value |
|---|---|
| `GCP_PROJECT` | the project id |
| `GCP_REGION` | the region |
| `GCP_WIF_PROVIDER` | printed in part 3 |
| `GCP_SERVICE_ACCOUNT` | the deployer address from part 3 |
| `AR_REPO` | `wise-biz` |
| `API_URL` | the API's public URL, used for the smoke test and as the console's `API_ORIGIN`. It does not exist before the first deploy: for the very first run use the URL Cloud Run prints for `wb-api-<ENV>` after a first attempt, or set a placeholder, run the deploy, then set the real value and run it again (the second run is quick) |

No GitHub secret is needed for the deploy: the images come from GHCR with the workflow token and everything else is in Secret Manager.

## 6. Release and first deploy

1. Merge to `master` with a green CI. If you also release the desktop and mobile apps from this tag, merge the `eas init` commit from part 8 first (`mobile.yml` reads `app.json` on the tagged commit, and a later commit does not change a tag). The desktop workflow needs `WISE_BIZ_API_URL` and `WISE_BIZ_UPDATE_URL`, which come from the deployed console, so for the very first release expect its run to fail and re-run it after step 3 once those variables exist.
2. Tag a release (`vX.Y.Z`) on that commit and push the tag. `images.yml` builds the four service images, scans them (HIGH and CRITICAL fail the run) and pushes them to GHCR. If the scan fails, read its table and fix the finding before you go on; do not skip the scan.
3. Actions, Deploy, Run workflow: version `vX.Y.Z`, environment `staging`. It copies the images to Artifact Registry, runs the migration job (must succeed), rolls the services and runs a smoke test on `/ready`.
4. Open the console URL, create the first account, create a business, go through onboarding. Check the logs of `wb-workers-staging` and `wb-api-staging` in Cloud Logging for errors.
5. Point your domain at the services (Cloud Run, Manage custom domains, or a load balancer) and update `CONSOLE_URL`, `AUTH_URL`, `CORS_ORIGINS`, `AUTH_RP_ID` and `API_URL` if they changed. Roll again.
6. Take a backup and run one restore into a new Neon branch (`docs/runbooks/restore.md`); record the time in its drill table. Do this before real data arrives.
7. Repeat parts 3 to 6 for `production`.

If anything goes wrong after step 3, follow `docs/runbooks/rollback.md`. Do not fix a failed migration forward under pressure.

## 7. Desktop (Windows, macOS, Linux) release

`desktop.yml` runs on a release tag, builds the installers for the three systems in the GitHub environment `desktop-release` and attaches them to the run as artifacts. The tag must equal the version in `apps/desktop/package.json` (tag `v0.2.1` needs `"version": "0.2.1"`); the workflow stops before building if they differ.

**Accounts and certificates**
- **Windows**: buy a code signing certificate from a certificate authority (an OV or EV certificate; neither removes the SmartScreen warning at once, because Microsoft builds reputation for the signed file and certificate over the first downloads). Export it as a `.pfx` with a password. Encode it: `base64 -w0 cert.pfx` (on Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`).
- **macOS**: join the Apple Developer Program (paid, yearly). In Certificates, create a **Developer ID Application** certificate, export it from Keychain Access as a `.p12` with a password and base64 it the same way. Create an app-specific password at appleid.apple.com (Sign-In and Security, App-Specific Passwords). Your Team ID is in the membership page.
- **Linux**: no signing step; the AppImage and deb are unsigned.

**GitHub environment `desktop-release`** (Settings, Environments): restrict it to the `v*.*.*` tags, and set
- variables: `WISE_BIZ_API_URL` (the https API/console origin the terminal talks to, from part 6) and `WISE_BIZ_UPDATE_URL` (the https origin that serves the update feed, below);
- secrets: `WIN_CSC_LINK` (the base64 `.pfx`), `WIN_CSC_KEY_PASSWORD`, `CSC_LINK` (the base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

**Update feed**: any https static host works. The simplest is a public R2 bucket or a Cloud Storage bucket behind a domain such as `https://updates.yourdomain/pos`. After a successful run, download the artifacts (installers, `latest*.yml`, `.blockmap` files) and upload them to that location. The installed terminals check `latest*.yml` there and update themselves. Copying the files is deliberately manual until you decide who may publish an update.

Steps for a release: set the version in `apps/desktop/package.json`, merge, tag `vX.Y.Z`, push the tag, approve the environment if you set reviewers, wait for the three builds, download the artifacts, test the installer on a clean machine (see below), then publish to the update feed.

Check: the Windows build runs the packaged smoke test (`package:smoke`: fuses set, the app starts and stays up). Install on a clean Windows PC, confirm the signature (right click, Properties, Digital Signatures) and that the app starts and reaches enrolment. On macOS, `spctl -a -vv "Wise Biz POS.app"` says `accepted` and `source=Notarized Developer ID`.

## 8. Mobile (Android and iOS) release with EAS

`mobile.yml` starts EAS builds on a release tag and returns; the build itself runs on Expo's machines, and you follow it in the Expo dashboard.

**One time, on your machine**
```bash
npm install -g eas-cli
eas login
cd apps/pos
eas init                      # creates the Expo project and writes extra.eas.projectId into app.json
git add app.json && git commit -m "chore(pos): add the Expo project id"
```
Open a pull request with that commit. The workflow refuses to build while `app.json` has no `projectId`.

Set the app's API address in both Expo environments (the app refuses to sign requests without it, and release bundles throw at start without it):
```bash
eas env:set production --name EXPO_PUBLIC_API_URL --value https://app.yourdomain --visibility plaintext --non-interactive
eas env:set preview    --name EXPO_PUBLIC_API_URL --value https://staging.yourdomain --visibility plaintext --non-interactive
```
Do the same for `EXPO_PUBLIC_RECEIPT_BASE_URL` if you use public receipt links.

**Accounts**
- **Apple Developer Program** (the same membership as the desktop). The bundle id is `biz.wise.pos` (`app.json`). EAS creates and stores the certificates and provisioning profiles for you the first time (`eas build --platform ios` asks you to sign in to your Apple account).
- **Google Play Console** (one-time fee). Create the app with the package name `biz.wise.pos`. EAS creates the upload keystore. Google requires the **first** upload of an app to be made by hand in the console; after that `eas submit` can upload.

**Expo access token** for the workflow: expo.dev, Account settings, Access tokens, create one. In GitHub create the environment `mobile-release`, restrict it to `master` and the `v*.*.*` tags, require a reviewer for production, and add the secret `EXPO_TOKEN`.

**Try it before you tag**: from `apps/pos`, `eas build --platform android --profile staging` (an internal-distribution build you can install on a phone). Fix anything the build says before relying on the tag.

**Release**: bump `version` in `apps/pos/app.json`, merge, tag `vX.Y.Z`. The workflow starts the production builds for both systems. When they finish, submit them to the stores from the Expo dashboard or with `eas submit`.

**JavaScript-only updates later**: add `expo-updates` to `apps/pos` (check the bundle size impact first, per `CLAUDE.md`), then set the repository variable `EAS_UPDATES_ENABLED=true`. Until both are done the update job stays off by design.

## 9. Sentry (error reports)

1. Create an account and an organization at sentry.io.
2. Create projects: one **Node** project for the server (api, workers, realtime share it; the service name tells them apart), and later one each for **Next.js** (console), **React Native** (POS app) and **Electron** (desktop shell).
3. In each project, Settings, Client Keys (DSN), copy the DSN.
4. Server: put the Node project's DSN in Secret Manager as `wb-<ENV>-SENTRY_DSN` and roll the services (re-run the deploy). The server starts the reporter only when `SENTRY_DSN` is set. It sends no personal data (see `docs/adr/0022-sentry-server-error-reporting.md`).
5. Alert rules: create an alert on new issues, and one on error rate, and send them to your email or a chat webhook.

The client apps (console, POS, desktop) are not wired to Sentry yet: each needs an SDK, and the POS app needs a bundle-size check first. Keep their DSNs for when they are added.

## 10. Before real customers: the P1-16 gate

`docs/prompts/P1/16-gate.md` lists the checks. What needs you and a real environment:
- run the full flows on staging with real devices (a low-end Android phone, a mid-range Windows PC, an iPhone);
- the offline chaos drill (cut the network mid-sale, kill the app mid-commit, move the clock two hours, sell the last unit on two terminals, 24 hours offline);
- performance on those devices against the budgets in `SYSTEM.md`, written into `docs/reports/P1-perf.md`;
- the k6 load run against staging;
- the restore drill from part 6;
- usability sessions with five cashiers and three owners.

Record results in `docs/reports/P1-gate.md` with a go or no-go for pilots.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Deploy stops with `missing secret wb-<ENV>-<NAME>` | create that secret (part 4); the name is exact |
| Deploy cannot authenticate to Google | `GCP_WIF_PROVIDER` or `GCP_SERVICE_ACCOUNT` wrong, or the provider's attribute condition does not match `OWNER/REPO` |
| Migration job fails to connect | `DATABASE_MIGRATOR_URL` is the pooled host; it must be the direct host |
| Images workflow fails on the scan | read the table in the log; fix the dependency or base-image finding |
| Desktop workflow: `Tag ... does not match apps/desktop version` | set the version in `apps/desktop/package.json` to the tag, merge, tag again |
| Desktop workflow: `WIN_CSC_LINK is not set` | add the signing secrets to the `desktop-release` environment |
| Mobile workflow: `has no extra.eas.projectId` | run `eas init` and commit `app.json` |
| Mobile workflow: `EXPO_PUBLIC_API_URL is not set in the Expo environment` | `eas env:set` it for `production` and `preview` |
| Sign-in works, passkeys fail | `AUTH_RP_ID` is not the console hostname |
