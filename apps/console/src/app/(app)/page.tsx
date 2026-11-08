"use client";

import Link from "next/link";
import { useState } from "react";

import { Card, Row, SkeletonRows, Stack, cx, styles } from "@/components/ui.tsx";
import { useApprovals } from "@/lib/approvals.ts";
import {
  useLiveProducts,
  useLiveSales,
  onlineTerminals,
  productLabel,
  topProducts,
  useNow,
} from "@/lib/dashboard.ts";
import { useDevices } from "@/lib/devices.ts";
import { formatPrice } from "@/lib/pricing.ts";
import { useBranches, useInvites, useMembers, useProfile } from "@/lib/queries.ts";
import { delta, describeDelta, isoDay, shiftDays, totals } from "@/lib/reports.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./ops.module.css";

/** One home tile. A failed or forbidden query shows a dash, never breaks the page. */
interface Tile {
  readonly label: string;
  readonly href: string;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly value: string;
}

export default function HomePage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const profile = useProfile(t);
  const branches = useBranches(t);
  const members = useMembers(t);
  const invites = useInvites(t);
  const approvals = useApprovals(t);
  const devices = useDevices(t);
  const now = useNow();
  const currency = profile.data?.currency ?? "";
  // Today against the same weekday last week: one request over the rollups, never the raw sales.
  const [today] = useState(() => isoDay(new Date()));
  const lastWeek = shiftDays(today, -7);
  const sales = useLiveSales(t, { from: lastWeek, to: today }, currency !== "");
  const products = useLiveProducts(t, { from: today, to: today }, currency !== "");
  const mine = (sales.data ?? []).filter((r) => r.key === today || r.key === lastWeek);
  const nowSum = totals(
    mine.filter((r) => r.key === today),
    currency,
  );
  const wasSum = totals(
    mine.filter((r) => r.key === lastWeek),
    currency,
  );
  const netDelta = delta(nowSum.netMinor, wasSum.netMinor);
  const top = topProducts(products.data ?? [], currency, 5);
  const memberCount = members.data?.pages.reduce((n, p) => n + p.members.length, 0);

  const tiles: readonly Tile[] = [
    {
      label: "Branches",
      href: "/settings?tab=branches",
      pending: branches.isPending,
      failed: branches.isError,
      value: String(branches.data?.filter((b) => !b.archived).length ?? 0),
    },
    {
      label: "People",
      href: "/people",
      pending: members.isPending,
      failed: members.isError,
      value: String(memberCount ?? 0),
    },
    {
      label: "Pending invites",
      href: "/people",
      pending: invites.isPending,
      failed: invites.isError,
      value: String(invites.data?.length ?? 0),
    },
    {
      // Terminals waiting for approval plus flagged sales; one side failing leaves only the other in the count.
      label: "Pending approvals",
      href: "/approvals",
      pending: approvals.sales.isPending || approvals.devices.isPending,
      failed: approvals.sales.isError && approvals.devices.isError,
      value: approvals.label === "" ? "0" : approvals.label,
    },
    {
      label: "Terminals online",
      href: "/devices",
      pending: devices.isPending,
      failed: devices.isError,
      value: String(onlineTerminals(devices.data ?? [], now)),
    },
  ];

  return (
    <Stack>
      <div>
        <p className="muted">Welcome back</p>
        <h1>{profile.data?.name ?? tenant.name}</h1>
      </div>
      <div className={s.tiles}>
        {tiles.map((tile) => (
          <Card key={tile.label}>
            <Stack>
              <h2 className={s.tileLabel}>{tile.label}</h2>
              {tile.pending ? (
                <SkeletonRows rows={1} label={`Loading ${tile.label.toLowerCase()}`} />
              ) : tile.failed ? (
                <span className={cx(s.kpi, "num")}>
                  <span aria-hidden>–</span>
                  <span className="sr-only">Could not be loaded</span>
                </span>
              ) : (
                <span aria-live="polite" className={cx(s.kpi, "num")}>
                  {tile.value}
                </span>
              )}
              <Link href={tile.href as never}>Open {tile.label.toLowerCase()}</Link>
            </Stack>
          </Card>
        ))}
      </div>
      {currency === "" ? null : (
        <Card>
          <Stack>
            <h2>Today</h2>
            {sales.isPending ? (
              <SkeletonRows rows={1} label="Loading today's sales" />
            ) : sales.isError ? (
              <p className="muted">Today's sales could not be loaded.</p>
            ) : (
              <div aria-live="polite">
                <Stack>
                  <span className={cx(s.kpi, "num")}>{formatPrice(nowSum.netMinor, currency)}</span>
                  <span className="muted">
                    {`${String(nowSum.salesCount)} sales. ${describeDelta(netDelta, "Same weekday last week")}`}
                  </span>
                </Stack>
              </div>
            )}
            <Link href={"/reports"}>Open reports</Link>
          </Stack>
        </Card>
      )}
      {currency === "" ? null : (
        <Card>
          <Stack>
            <h2>Top items today</h2>
            {products.isPending ? (
              <SkeletonRows rows={5} label="Loading top items" />
            ) : products.isError ? (
              <p className="muted">Top items could not be loaded.</p>
            ) : top.length === 0 ? (
              <p className="muted">No items sold yet today.</p>
            ) : (
              <>
                <ol className={s.topList}>
                  {top.map((r) => (
                    <li key={r.variantId} className={s.topRow}>
                      <span className={s.topName}>{productLabel(r)}</span>
                      <span className="muted num">{`${r.qty} sold`}</span>
                      <span className="num">{formatPrice(r.netMinor, currency)}</span>
                    </li>
                  ))}
                </ol>
                <span className="muted">Net sales, highest first.</span>
              </>
            )}
            <Link href={"/reports"}>All products</Link>
          </Stack>
        </Card>
      )}
      <Card>
        <Stack>
          <h2>Next steps</h2>
          <Row>
            <Link className={cx(styles.button, styles.secondary)} href={"/people?invite=1"}>
              Invite a person
            </Link>
            <Link
              className={cx(styles.button, styles.secondary)}
              href={"/settings?tab=branches&new=1"}
            >
              Add a branch
            </Link>
            <Link className={cx(styles.button, styles.secondary)} href="/audit">
              Review recent changes
            </Link>
          </Row>
          <p className="muted">Tip: press Ctrl K anywhere to jump to a page or action.</p>
        </Stack>
      </Card>
    </Stack>
  );
}
