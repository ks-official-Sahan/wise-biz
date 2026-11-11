"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";

import { ConfirmAction } from "@/components/confirm-action.tsx";
import {
  Badge,
  Button,
  Empty,
  ErrorState,
  LinkButton,
  Row,
  SkeletonRows,
  Stack,
  styles,
} from "@/components/ui.tsx";
import { api, isNotFound } from "@/lib/api.ts";
import { formatPrice, useVariantNames } from "@/lib/pricing.ts";
import {
  PO_STATUS_LABEL,
  openQty,
  poActions,
  procurementKeys,
  useReturnFocus,
  useSupplierNames,
  usePo,
} from "@/lib/procurement.ts";
import { useLocations } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../procurement.module.css";

import { ReceivePoDialog } from "./receive-dialog.tsx";

import type { MouseEvent } from "react";

type ActionKind = "receive" | "send" | "close" | "cancel";

export default function PurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const po = usePo(t, id);
  const suppliers = useSupplierNames(t);
  const order = po.data;
  const locations = useLocations(t, order?.branchId ?? null);
  const names = useVariantNames(t, [...new Set(order?.lines.map((l) => l.variantId) ?? [])]);
  const titles = useMemo(
    () => new Map([...names].map(([variantId, v]) => [variantId, `${v.productName} · ${v.name}`])),
    [names],
  );
  const [dialog, setDialog] = useState<ActionKind | null>(null);
  const focus = useReturnFocus();

  if (po.isPending || order === undefined) return <SkeletonRows label="Loading purchase order" />;
  if (po.isError)
    return isNotFound(po.error) ? (
      <Empty title="Order not found">It may have been removed, or your role cannot see it.</Empty>
    ) : (
      <ErrorState
        error={po.error}
        onRetry={() => {
          void po.refetch();
        }}
      />
    );
  const x = order;
  const actions = poActions(x);
  const supplier = suppliers.get(x.supplierId)?.name ?? "…";
  const location = locations.data?.find((l) => l.locationId === x.locationId)?.name ?? "…";
  const m = (minor: number) => formatPrice(minor, x.currency);
  const open = (kind: ActionKind, e: MouseEvent<HTMLButtonElement>) => {
    focus.remember(e.currentTarget);
    setDialog(kind);
  };
  const close = () => {
    setDialog(null);
    focus.restore();
  };
  /** Each action is one POST with the version it read; a version clash answers 409 and the page reloads. */
  const act = (path: string) => async (key: string) => {
    await api("POST", `/v1/procurement/purchase-orders/${encodeURIComponent(x.id)}${path}`, {
      body: { version: x.version },
      idempotencyKey: key,
    });
    await qc.invalidateQueries({ queryKey: procurementKeys.all(t) });
  };

  return (
    <Stack>
      <Row spread>
        <div>
          <h1>{`PO ${String(x.poNo)}`}</h1>
          <p className={styles.muted}>
            {`${supplier} · ${location}`}
            {x.expectedOn === null ? "" : ` · expected ${x.expectedOn}`}
          </p>
        </div>
        <div className={s.actions}>
          <LinkButton variant="secondary" href="/purchasing">
            All orders
          </LinkButton>
          {actions.cancel ? (
            <Button
              variant="secondary"
              onClick={(e) => {
                open("cancel", e);
              }}
            >
              Cancel order
            </Button>
          ) : null}
          {actions.close ? (
            <Button
              variant="secondary"
              onClick={(e) => {
                open("close", e);
              }}
            >
              Close order
            </Button>
          ) : null}
          {actions.send ? (
            <Button
              onClick={(e) => {
                open("send", e);
              }}
            >
              Send to supplier
            </Button>
          ) : null}
          {actions.receive ? (
            <Button
              onClick={(e) => {
                open("receive", e);
              }}
            >
              Receive goods
            </Button>
          ) : null}
        </div>
      </Row>

      <p>
        <Badge tone={x.status === "draft" ? "neutral" : "accent"}>
          {PO_STATUS_LABEL[x.status]}
        </Badge>
      </p>

      <dl className={s.facts}>
        <dt>Total</dt>
        <dd className={s.total}>{m(x.totalMinor)}</dd>
        <dt>Currency</dt>
        <dd>{x.currency}</dd>
        <dt>Sent</dt>
        <dd>{x.sentAt === null ? "Not yet" : new Date(x.sentAt).toLocaleDateString()}</dd>
        <dt>Closed</dt>
        <dd>{x.closedAt === null ? "Not yet" : new Date(x.closedAt).toLocaleDateString()}</dd>
      </dl>
      {x.notes === "" ? null : <p>{x.notes}</p>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">Lines of PO {String(x.poNo)}</caption>
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col" className={s.num}>
                Ordered
              </th>
              <th scope="col" className={s.num}>
                Received
              </th>
              <th scope="col" className={s.num}>
                Open
              </th>
              <th scope="col" className={s.num}>
                Unit cost
              </th>
              <th scope="col" className={s.num}>
                Line total
              </th>
            </tr>
          </thead>
          <tbody>
            {x.lines.map((l) => (
              <tr key={l.line}>
                <th scope="row">{titles.get(l.variantId) ?? "…"}</th>
                <td className={s.num}>{l.orderedQty}</td>
                <td className={s.num}>{l.receivedQty}</td>
                <td className={s.num}>{openQty(l.orderedQty, l.receivedQty)}</td>
                <td className={s.num}>{m(l.unitCostMinor)}</td>
                <td className={s.num}>{m(l.lineTotalMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialog === "receive" ? <ReceivePoDialog po={x} titles={titles} onClose={close} /> : null}
      {dialog === "send" ? (
        <ConfirmAction
          title={`Send PO ${String(x.poNo)} to ${supplier}?`}
          confirmLabel="Send order"
          onClose={close}
          run={act("/send")}
        >
          <p>It becomes read-only and the supplier is notified.</p>
        </ConfirmAction>
      ) : null}
      {dialog === "close" ? (
        <ConfirmAction
          title={`Close PO ${String(x.poNo)}?`}
          confirmLabel="Close order"
          onClose={close}
          run={act("/close")}
        >
          <p>Any shortfall is recorded as variance. A closed order takes no more receipts.</p>
        </ConfirmAction>
      ) : null}
      {dialog === "cancel" ? (
        <ConfirmAction
          title={`Cancel PO ${String(x.poNo)}?`}
          confirmLabel="Cancel order"
          danger
          onClose={close}
          run={act("/cancel")}
        >
          <p>The order is cancelled. Nothing has been received against it.</p>
        </ConfirmAction>
      ) : null}
    </Stack>
  );
}
