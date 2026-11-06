# 0023. Object storage stays inside the R2 free tier

Status: accepted
Date: 2026-11-06

## Context

Object storage is Cloudflare R2 (exports, import files, product images). R2 has a monthly free tier: 10 GB-month of
Standard storage, 1 million Class A and 10 million Class B operations. Beyond it Cloudflare bills $0.015 per GB-month,
$4.50 per million Class A and $0.36 per million Class B. The owner wants no overage bill at all.

Facts from the Cloudflare documentation (r2/pricing, r2/platform/metrics-analytics, checked 2026-11-06):

- Operations are counted per billing period and reset each period. Storage is a level: the average of the daily peak
  over the period, so it does not reset; deleting objects lowers it.
- Billing rounds up: one million and one operations bill as two million.
- Class A: ListObjects, PutObject, CopyObject, multipart calls and bucket writes. Class B: GetObject, HeadObject and
  bucket reads. Deletes and aborting a multipart upload are free. Egress is free.
- Usage is available through the GraphQL Analytics API (`r2OperationsAdaptiveGroups`, `r2StorageAdaptiveGroups`), at most
  31 days per query, with an ingestion delay. The quota is per account, not per bucket: staging and production buckets
  in one account share it.
- Cloudflare has no hard spending cap.

## Decision

1. Caps below the free tier: 9.5 GB, 900,000 Class A, 9,500,000 Class B (`R2_LIMIT_*`, defaults in
   `packages/storage/src/quota.ts`). Storage uses decimal GB, the smaller reading, so the cap is the safer one.
2. A gate in `@wise-biz/storage` wraps the store (`guardStore`). Every presigned URL, `get` and `put` is admitted first.
   A call that would pass a cap throws `STORAGE_QUOTA_EXCEEDED` (HTTP 503, problem type `storage/quota-exceeded`), which
   clients show as "storage is at its monthly limit". Deletes are never blocked, so a full bucket can always be cleaned.
3. The gate reads usage from Cloudflare every minute (`CLOUDFLARE_ANALYTICS_TOKEN`, permission Account Analytics: Read)
   and adds this process's own calls from the last 10 minutes on top, because the reading lags. Counting a call twice only
   makes the gate stricter. When a read fails it keeps the last reading and keeps counting. Without the token it counts
   only its own process and logs a warning; production should set the token.
4. The period follows the Cloudflare billing period: `R2_PERIOD_ANCHOR_DAY` (1 to 28, UTC). Operation counts reset on that
   day, stored bytes do not.
5. Alerts: the log carries a warning at 80% and an error at the cap, the cap also goes to Sentry, and the workflow
   `r2-usage.yml` checks hourly, warns at 80% and fails at the cap so GitHub emails the owner. The same script
   (`pnpm -F @wise-biz/storage r2-usage`) can run before any workflow step that writes to R2.
6. The gate applies only when `STORAGE_ENDPOINT` is an R2 endpoint. MinIO in development and AWS S3 are not capped.

## Consequences

- Strict only for traffic that passes through wise-biz. Uploads made by hand in the Cloudflare dashboard or another tool
  are not blocked; the analytics reading sees them and the gate then refuses wise-biz traffic until usage falls.
- Several service instances each keep their own recent calls, so the true count can run ahead of one instance's view by
  the calls of the other instances in the last minute. The 5% to 10% headroom under each free-tier limit is for this.
- A presigned upload URL counts when it is issued, even if the client never uses it: slightly early, never late.
- A client's direct request to R2 (it holds a presigned URL) cannot be intercepted. URLs are short-lived and their count
  is already in the gate.
- Class B at the cap also blocks downloads of existing files. That is the price of a hard ceiling.

## Alternatives not taken now

- **A second R2 account** with the same caps. Each object would need a recorded home (which account holds it), so reads
  find it and the gate can pick an account with room. That needs a column on every table that points at an object. Add it
  only when a month actually reaches the caps; the store port (`ObjectStore`) and the gate are the seam where a pool of
  accounts would plug in.
- **Cloudinary** for product images. It has its own free plan with its own units (credits) and its own API, so it needs a
  separate adapter and a second gate. Worth considering for images only, later, if images are what fills the caps.
- **Cloudflare Workers binding for R2**, which would let a Worker count every call. The services run on Cloud Run and use
  the S3 API, so a binding is not available to them.
