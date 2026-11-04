"use client";

import { useParams } from "next/navigation";

import {
  Alert,
  Badge,
  Button,
  ErrorState,
  LinkButton,
  Row,
  SkeletonRows,
  Stack,
  styles,
} from "@/components/ui.tsx";
import { formatPrice } from "@/lib/pricing.ts";
import { useBranches } from "@/lib/queries.ts";
import { cashWalk, flagLabel, tenderLabel, useShift, variance } from "@/lib/sales.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../../ops.module.css";

export default function ShiftPage() {
  const { id } = useParams<{ id: string }>();
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const shift = useShift(t, id);
  const branches = useBranches(t);

  if (shift.isPending) return <SkeletonRows label="Loading shift" />;
  if (shift.isError)
    return (
      <ErrorState
        error={shift.error}
        onRetry={() => {
          void shift.refetch();
        }}
      />
    );
  const x = shift.data;
  const z = x.zReport;
  const m = (minor: number) => formatPrice(minor, x.currency);
  const v = variance(z === null ? null : z.cash.overShortMinor);
  const branch = branches.data?.find((b) => b.branchId === x.branchId)?.name ?? "…";

  return (
    <Stack>
      <Row spread>
        <div>
          <h1>{x.status === "open" ? "Shift (open)" : "Z-report"}</h1>
          <p className={styles.muted}>
            {branch} · opened {new Date(x.openedAt).toLocaleString()}
            {x.closedAt === null ? "" : ` · closed ${new Date(x.closedAt).toLocaleString()}`}
          </p>
        </div>
        <Row>
          <span className={s.noPrint}>
            <LinkButton variant="secondary" href="/shifts">
              All shifts
            </LinkButton>
          </span>
          {z === null ? null : (
            <span className={s.noPrint}>
              <Button
                onClick={() => {
                  globalThis.print();
                }}
              >
                Print Z-report
              </Button>
            </span>
          )}
        </Row>
      </Row>

      {x.flags.length === 0 ? null : (
        <span className={s.flags}>
          {x.flags.map((f) => (
            <Badge key={f} tone="warning">
              {flagLabel(f)}
            </Badge>
          ))}
        </span>
      )}

      {z === null ? (
        <Alert tone="info">
          This shift is still open. The Z-report is frozen when the till closes it.
        </Alert>
      ) : (
        <div className={s.report}>
          {v === "balanced" || v === "unknown" ? null : (
            <Alert tone="danger">
              {`The drawer is ${v === "over" ? "over" : "short"} by ${m(Math.abs(z.cash.overShortMinor))}.`}
            </Alert>
          )}
          <h2>Sales</h2>
          <dl className={s.kv}>
            <dt>Sales</dt>
            <dd>{`${String(z.sales.count)} · ${m(z.sales.payableMinor)}`}</dd>
            <dt>Tax included</dt>
            <dd>{m(z.sales.taxMinor)}</dd>
            <dt>Discounts given</dt>
            <dd>{m(z.sales.discountMinor)}</dd>
            <dt>Voids</dt>
            <dd>{`${String(z.voids.count)} · ${m(z.voids.payableMinor)}`}</dd>
            <dt>Returns</dt>
            <dd>{`${String(z.returns.count)} · ${m(z.returns.totalMinor)}`}</dd>
          </dl>

          <h2>By payment type</h2>
          <dl className={s.kv}>
            {z.tenders.map((tn) => (
              <div key={tn.kind} style={{ display: "contents" }}>
                <dt>{tenderLabel(tn.kind)}</dt>
                <dd>
                  {m(tn.salesMinor)}
                  {tn.refundsMinor === 0 ? "" : ` (refunded ${m(tn.refundsMinor)})`}
                </dd>
              </div>
            ))}
          </dl>

          <h2>Cash drawer</h2>
          <dl className={s.kv}>
            {cashWalk(z).map((row) =>
              row.minor === 0 ? null : (
                <div key={row.label} style={{ display: "contents" }}>
                  <dt>{row.label}</dt>
                  <dd>{m(row.minor)}</dd>
                </div>
              ),
            )}
            <dt className={s.total}>Expected</dt>
            <dd className={s.total}>{m(z.cash.expectedMinor)}</dd>
            <dt>Counted</dt>
            <dd>
              {x.blindCount === true
                ? `${m(z.cash.countedMinor)} (blind count)`
                : m(z.cash.countedMinor)}
            </dd>
            <dt>Over / short</dt>
            <dd>{m(z.cash.overShortMinor)}</dd>
            <dt>Drawer opened</dt>
            <dd>{`${String(z.drawerOpens)} times`}</dd>
          </dl>
        </div>
      )}
    </Stack>
  );
}
