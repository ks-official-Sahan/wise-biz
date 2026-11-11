"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  Badge,
  Button,
  Empty,
  ErrorState,
  Row,
  SelectField,
  SkeletonRows,
  Stack,
  styles,
} from "@/components/ui.tsx";
import { isNotFound } from "@/lib/api.ts";
import {
  TRANSFER_STATUS_LABEL,
  inTransitText,
  useAllLocations,
  useReturnFocus,
  useTransfers,
} from "@/lib/procurement.ts";
import { useBranches } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../purchasing/procurement.module.css";

import { NewTransferDialog } from "./transfer-dialog.tsx";

import type { TransferStatus } from "@/lib/procurement.ts";

const STATUSES: readonly TransferStatus[] = [
  "requested",
  "dispatched",
  "received",
  "closed",
  "cancelled",
];

export default function TransfersPage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [status, setStatus] = useState<TransferStatus | "">("");
  const [creating, setCreating] = useState(false);
  const focus = useReturnFocus();
  const transfers = useTransfers(t, status);
  const branches = useBranches(t);
  const branchIds = useMemo(
    () => (branches.data ?? []).filter((b) => !b.archived).map((b) => b.branchId),
    [branches.data],
  );
  const locations = useAllLocations(t, branchIds);
  const rows = useMemo(() => transfers.data?.pages.flatMap((p) => p.items) ?? [], [transfers.data]);
  const branchName = new Map((branches.data ?? []).map((b) => [b.branchId, b.name] as const));
  const locationName = new Map(
    locations.map(
      (l) => [l.locationId, `${branchName.get(l.branchId) ?? ""} · ${l.name}`] as const,
    ),
  );

  return (
    <Stack>
      <Row spread>
        <h1>Transfers</h1>
        <Button
          onClick={(e) => {
            focus.remember(e.currentTarget);
            setCreating(true);
          }}
        >
          New transfer
        </Button>
      </Row>

      <div className={s.grid}>
        <SelectField
          label="Status"
          value={status}
          options={[
            { value: "", label: "All transfers" },
            ...STATUSES.map((x) => ({ value: x, label: TRANSFER_STATUS_LABEL[x] })),
          ]}
          onChange={(e) => {
            setStatus(e.target.value as TransferStatus | "");
          }}
        />
      </div>

      {transfers.isPending ? <SkeletonRows label="Loading transfers" /> : null}
      {transfers.isError ? (
        isNotFound(transfers.error) ? (
          <Empty title="Transfers are not open to your role">
            Ask an owner to grant purchasing access.
          </Empty>
        ) : (
          <ErrorState
            error={transfers.error}
            onRetry={() => {
              void transfers.refetch();
            }}
          />
        )
      ) : null}
      {transfers.isSuccess && rows.length === 0 ? (
        <Empty title="No transfers yet">
          Request a transfer to move stock between two locations.
        </Empty>
      ) : null}
      {rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Stock transfers, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Transfer</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Status</th>
                <th scope="col">In transit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id}>
                  <th scope="row">
                    <Link href={`/transfers/${x.id}`}>{`Transfer ${String(x.transferNo)}`}</Link>
                  </th>
                  <td>{locationName.get(x.fromLocationId) ?? "…"}</td>
                  <td>{locationName.get(x.toLocationId) ?? "…"}</td>
                  <td>
                    <Badge tone={x.status === "dispatched" ? "accent" : "neutral"}>
                      {TRANSFER_STATUS_LABEL[x.status]}
                    </Badge>
                  </td>
                  <td>{inTransitText(x)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {transfers.hasNextPage ? (
        <Button
          variant="secondary"
          busy={transfers.isFetchingNextPage}
          onClick={() => {
            void transfers.fetchNextPage();
          }}
        >
          Load more
        </Button>
      ) : null}

      {creating ? (
        <NewTransferDialog
          onClose={() => {
            setCreating(false);
            focus.restore();
          }}
        />
      ) : null}
    </Stack>
  );
}
