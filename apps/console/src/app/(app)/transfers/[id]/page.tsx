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
  TRANSFER_STATUS_LABEL,
  inTransitText,
  procurementKeys,
  transferActions,
  useAllLocations,
  useReturnFocus,
  useTransfer,
  varianceText,
} from "@/lib/procurement.ts";
import { useBranches } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../../purchasing/procurement.module.css";

import { DispatchDialog, ReceiveTransferDialog } from "./transfer-dialogs.tsx";

import type { MouseEvent } from "react";

type ActionKind = "dispatch" | "receive" | "close" | "cancel";

export default function TransferPage() {
  const { id } = useParams<{ id: string }>();
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const transfer = useTransfer(t, id);
  const x = transfer.data;
  const branches = useBranches(t);
  const branchIds = useMemo(
    () => (branches.data ?? []).filter((b) => !b.archived).map((b) => b.branchId),
    [branches.data],
  );
  const locations = useAllLocations(t, branchIds);
  const names = useVariantNames(t, [...new Set(x?.lines.map((l) => l.variantId) ?? [])]);
  const titles = useMemo(
    () => new Map([...names].map(([variantId, v]) => [variantId, `${v.productName} · ${v.name}`])),
    [names],
  );
  const [dialog, setDialog] = useState<ActionKind | null>(null);
  const focus = useReturnFocus();

  if (transfer.isPending || x === undefined)
    return transfer.isError ? (
      isNotFound(transfer.error) ? (
        <Empty title="Transfer not found">
          It may have been removed, or your role cannot see it.
        </Empty>
      ) : (
        <ErrorState
          error={transfer.error}
          onRetry={() => {
            void transfer.refetch();
          }}
        />
      )
    ) : (
      <SkeletonRows label="Loading transfer" />
    );

  const actions = transferActions(x);
  const label = (locationId: string): string => {
    const loc = locations.find((l) => l.locationId === locationId);
    if (loc === undefined) return "…";
    const branch = branches.data?.find((b) => b.branchId === loc.branchId)?.name ?? "";
    return `${branch} · ${loc.name}`;
  };
  const m = (minor: number) => (x.currency === null ? "" : formatPrice(minor, x.currency));
  const open = (kind: ActionKind, e: MouseEvent<HTMLButtonElement>) => {
    focus.remember(e.currentTarget);
    setDialog(kind);
  };
  const close = () => {
    setDialog(null);
    focus.restore();
  };
  /** Close and cancel carry the version the page read; a clash answers 409 and the page reloads. */
  const act = (path: string) => async (key: string) => {
    await api("POST", `/v1/procurement/transfers/${encodeURIComponent(x.id)}${path}`, {
      body: { version: x.version },
      idempotencyKey: key,
    });
    await qc.invalidateQueries({ queryKey: procurementKeys.all(t) });
  };
  const settled = x.status === "received" || x.status === "closed";

  return (
    <Stack>
      <Row spread>
        <div>
          <h1>{`Transfer ${String(x.transferNo)}`}</h1>
          <p className={styles.muted}>{`${label(x.fromLocationId)} to ${label(x.toLocationId)}`}</p>
        </div>
        <div className={s.actions}>
          <LinkButton variant="secondary" href="/transfers">
            All transfers
          </LinkButton>
          {actions.cancel ? (
            <Button
              variant="secondary"
              onClick={(e) => {
                open("cancel", e);
              }}
            >
              Cancel transfer
            </Button>
          ) : null}
          {actions.close ? (
            <Button
              variant="secondary"
              onClick={(e) => {
                open("close", e);
              }}
            >
              Close transfer
            </Button>
          ) : null}
          {actions.dispatch ? (
            <Button
              onClick={(e) => {
                open("dispatch", e);
              }}
            >
              Dispatch stock
            </Button>
          ) : null}
          {actions.receive ? (
            <Button
              onClick={(e) => {
                open("receive", e);
              }}
            >
              Receive stock
            </Button>
          ) : null}
        </div>
      </Row>

      <p>
        <Badge tone={x.status === "dispatched" ? "accent" : "neutral"}>
          {TRANSFER_STATUS_LABEL[x.status]}
        </Badge>{" "}
        <span className={styles.muted}>{inTransitText(x)}</span>
      </p>

      {x.notes === "" ? null : <p>{x.notes}</p>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">Lines of transfer {String(x.transferNo)}</caption>
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col" className={s.num}>
                Requested
              </th>
              <th scope="col" className={s.num}>
                Dispatched
              </th>
              <th scope="col" className={s.num}>
                Received
              </th>
              <th scope="col">Variance</th>
              <th scope="col" className={s.num}>
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {x.lines.map((l) => (
              <tr key={l.line}>
                <th scope="row">{titles.get(l.variantId) ?? "…"}</th>
                <td className={s.num}>{l.requestedQty}</td>
                <td className={s.num}>{l.dispatchedQty}</td>
                <td className={s.num}>{l.receivedQty}</td>
                <td>{settled ? varianceText(l.varianceQty) : "Not received yet"}</td>
                <td className={s.num}>
                  {x.currency === null ? "Not dispatched yet" : m(l.valueMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialog === "dispatch" ? (
        <DispatchDialog transfer={x} titles={titles} onClose={close} />
      ) : null}
      {dialog === "receive" ? (
        <ReceiveTransferDialog transfer={x} titles={titles} onClose={close} />
      ) : null}
      {dialog === "close" ? (
        <ConfirmAction
          title={`Close transfer ${String(x.transferNo)}?`}
          confirmLabel="Close transfer"
          onClose={close}
          run={act("/close")}
        >
          <p>A closed transfer takes no more receipts.</p>
        </ConfirmAction>
      ) : null}
      {dialog === "cancel" ? (
        <ConfirmAction
          title={`Cancel transfer ${String(x.transferNo)}?`}
          confirmLabel="Cancel transfer"
          danger
          onClose={close}
          run={act("/cancel")}
        >
          <p>Nothing has moved yet, so no stock is affected.</p>
        </ConfirmAction>
      ) : null}
    </Stack>
  );
}
