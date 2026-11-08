"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import {
  Alert,
  Badge,
  ErrorState,
  LinkButton,
  Row,
  SkeletonRows,
  Stack,
  styles,
} from "@/components/ui.tsx";
import { formatPrice } from "@/lib/pricing.ts";
import { useBranches } from "@/lib/queries.ts";
import { flagLabel, operatorLabel, tenderLabel, useOperatorNames, useSale } from "@/lib/sales.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../../ops.module.css";

export default function SalePage() {
  const { id } = useParams<{ id: string }>();
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const sale = useSale(t, id);
  const branches = useBranches(t);
  const { userId } = useTenant();
  const operators = useOperatorNames(t, userId);

  if (sale.isPending) return <SkeletonRows label="Loading sale" />;
  if (sale.isError)
    return (
      <ErrorState
        error={sale.error}
        onRetry={() => {
          void sale.refetch();
        }}
      />
    );
  const x = sale.data;
  const m = (minor: number) => formatPrice(minor, x.currency);
  const branch = branches.data?.find((b) => b.branchId === x.branchId)?.name ?? "…";

  return (
    <Stack>
      <Row spread>
        <div>
          <h1>{`Sale #${String(x.saleNo)}`}</h1>
          <p className={styles.muted}>
            {new Date(x.completedAt).toLocaleString()} · {branch} ·{" "}
            {operatorLabel(x.operatorId, operators)}
            {x.invoiceNo === null ? "" : ` · invoice ${x.invoiceNo}`}
          </p>
        </div>
        <LinkButton variant="secondary" href="/sales">
          All sales
        </LinkButton>
      </Row>

      <span className={s.flags}>
        {x.status === "voided" ? <Badge tone="warning">Voided</Badge> : <Badge>Completed</Badge>}
        {x.flags.map((f) => (
          <Badge key={f} tone="warning">
            {flagLabel(f)}
          </Badge>
        ))}
      </span>

      {x.void == null ? null : (
        <Alert tone="info">
          {`Voided ${new Date(x.void.occurredAt).toLocaleString()}: ${x.void.reason}`}
          {x.void.overrideId === null ? "" : " (manager override)"}
        </Alert>
      )}

      <h2>Items</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">Items sold</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className={s.num}>
                Qty
              </th>
              <th scope="col" className={s.num}>
                Price
              </th>
              <th scope="col" className={s.num}>
                Discount
              </th>
              <th scope="col" className={s.num}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {(x.lines ?? []).map((l) => (
              <tr key={l.line}>
                <th scope="row">
                  {l.name} <span className={styles.muted}>{l.sku}</span>
                  {l.priceSource === "override" ? (
                    <Badge tone="warning">Price changed</Badge>
                  ) : null}
                </th>
                <td className={s.num}>{l.qty}</td>
                <td className={s.num}>{m(l.unitPriceMinor)}</td>
                <td className={s.num}>{l.discountMinor === 0 ? "" : m(-l.discountMinor)}</td>
                <td className={s.num}>{m(l.totalMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={s.grid}>
        <section>
          <h2>Totals</h2>
          <dl className={s.kv}>
            <dt>Subtotal</dt>
            <dd>{m(x.subtotalMinor)}</dd>
            {x.discountMinor === 0 ? null : (
              <>
                <dt>Discounts</dt>
                <dd>{m(-x.discountMinor)}</dd>
              </>
            )}
            {x.feeMinor === 0 ? null : (
              <>
                <dt>Fees</dt>
                <dd>{m(x.feeMinor)}</dd>
              </>
            )}
            <dt>Tax</dt>
            <dd>{m(x.taxMinor)}</dd>
            {x.cashRoundingMinor === 0 ? null : (
              <>
                <dt>Cash rounding</dt>
                <dd>{m(x.cashRoundingMinor)}</dd>
              </>
            )}
            <dt className={s.total}>Paid</dt>
            <dd className={s.total}>{m(x.payableMinor)}</dd>
          </dl>
        </section>
        <section>
          <h2>Payment</h2>
          <dl className={s.kv}>
            {(x.tenders ?? []).map((tn) => (
              <div key={tn.id} style={{ display: "contents" }}>
                <dt>{tenderLabel(tn.kind)}</dt>
                <dd>
                  {m(tn.amountMinor)}
                  {tn.receivedMinor !== null && tn.changeMinor !== null && tn.changeMinor > 0
                    ? ` (given ${m(tn.receivedMinor)}, change ${m(tn.changeMinor)})`
                    : ""}
                  {tn.card?.brand == null ? "" : ` · ${tn.card.brand}`}
                  {tn.card?.authCode == null ? "" : ` · auth ${tn.card.authCode}`}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      {(x.returns ?? []).length === 0 ? null : (
        <>
          <h2>Returns</h2>
          <ul>
            {(x.returns ?? []).map((r) => (
              <li key={r.id}>
                {`Return #${String(r.returnNo)}, ${m(r.totalMinor)} refunded on ${new Date(r.occurredAt).toLocaleDateString()}: ${r.reason}`}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className={styles.muted}>
        Shift: <Link href={`/shifts/${x.shiftId}`}>open the shift</Link>
      </p>
    </Stack>
  );
}
