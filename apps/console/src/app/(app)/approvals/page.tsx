"use client";

import Link from "next/link";

import { Badge, Empty, ErrorState, Row, SkeletonRows, Stack, styles } from "@/components/ui.tsx";
import { useApprovals } from "@/lib/approvals.ts";
import { ago } from "@/lib/devices.ts";
import { formatPrice } from "@/lib/pricing.ts";
import { flagLabel } from "@/lib/sales.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../ops.module.css";

const PLATFORM = {
  android: "Android",
  ios: "iPhone / iPad",
  windows: "Windows",
  macos: "Mac",
  linux: "Linux",
  web: "Browser",
} as const;

/** What needs a look from someone with authority: flagged sales and terminals that have not finished enrolling. */
export default function ApprovalsPage() {
  const { tenant } = useTenant();
  const { sales, devices, flagged, waiting, label } = useApprovals(tenant.tenantId);

  return (
    <Stack>
      <Row spread>
        <h1>Approvals</h1>
        {label === "" ? null : <Badge tone="warning">{`${label} waiting`}</Badge>}
      </Row>

      <section aria-labelledby="approvals-devices">
        <h2 id="approvals-devices">Terminals that have not finished enrolling</h2>
        {devices.isPending ? <SkeletonRows rows={2} label="Loading terminals" /> : null}
        {devices.isError ? (
          <ErrorState
            error={devices.error}
            onRetry={() => {
              void devices.refetch();
            }}
          />
        ) : null}
        {devices.isSuccess && waiting.length === 0 ? (
          <Empty title="No unfinished enrolments">
            A terminal shows up here after its enrolment code is created and until it is used.
            Review it to cancel a code that was never used.
          </Empty>
        ) : null}
        {waiting.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">Terminals that have not finished enrolling</caption>
              <thead>
                <tr>
                  <th scope="col">Terminal</th>
                  <th scope="col">Type</th>
                  <th scope="col">Enrolled</th>
                  <th scope="col">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((d) => (
                  <tr key={d.deviceId}>
                    <th scope="row">{d.name}</th>
                    <td>{PLATFORM[d.platform]}</td>
                    <td>{ago(d.enrolledAt)}</td>
                    <td>
                      <Link href="/devices">Review</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="approvals-sales">
        <h2 id="approvals-sales">Sales to review</h2>
        {sales.isPending ? <SkeletonRows rows={3} label="Loading sales" /> : null}
        {sales.isError ? (
          <ErrorState
            error={sales.error}
            onRetry={() => {
              void sales.refetch();
            }}
          />
        ) : null}
        {sales.isSuccess && flagged.length === 0 ? (
          <Empty title="No sales to review">
            Sales with a price difference, an override or a cash difference appear here.
          </Empty>
        ) : null}
        {flagged.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">Sales flagged for review, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Sale</th>
                  <th scope="col">When</th>
                  <th scope="col" className={s.num}>
                    Total
                  </th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {flagged.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">
                      <Link href={`/sales/${r.id}`}>{`#${String(r.saleNo)}`}</Link>
                    </th>
                    <td>{new Date(r.completedAt).toLocaleString()}</td>
                    <td className={s.num}>{formatPrice(r.payableMinor, r.currency)}</td>
                    <td>
                      <span className={s.flags}>
                        {r.flags.map((f) => (
                          <Badge key={f} tone="warning">
                            {flagLabel(f)}
                          </Badge>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {sales.data?.pages[0]?.nextCursor !== null &&
        sales.data?.pages[0]?.nextCursor !== undefined ? (
          <p className={styles.muted}>
            Showing the newest 50. <Link href="/sales">Open all sales</Link> to filter the rest.
          </p>
        ) : null}
      </section>
    </Stack>
  );
}
