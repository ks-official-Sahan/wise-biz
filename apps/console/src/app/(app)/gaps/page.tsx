"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  Badge,
  Button,
  Empty,
  ErrorState,
  SelectField,
  SkeletonRows,
  Stack,
  styles,
} from "@/components/ui.tsx";
import { isNotFound } from "@/lib/api.ts";
import {
  GAP_STATUSES,
  GAP_STATUS_LABEL,
  assigneeText,
  gapValueText,
  gapVarianceText,
  useGaps,
} from "@/lib/gaps.ts";
import { useVariantNames } from "@/lib/pricing.ts";
import { useAllLocations } from "@/lib/procurement.ts";
import { useBranches } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import inv from "../inventory.module.css";
import p from "../purchasing/procurement.module.css";

import type { GapStatus } from "@/lib/gaps.ts";

export default function GapsPage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [status, setStatus] = useState<GapStatus | "">("");
  const gaps = useGaps(t, status);
  const branches = useBranches(t);
  const branchIds = useMemo(
    () => (branches.data ?? []).filter((b) => !b.archived).map((b) => b.branchId),
    [branches.data],
  );
  const locations = useAllLocations(t, branchIds);
  const rows = useMemo(() => gaps.data?.pages.flatMap((pg) => pg.items) ?? [], [gaps.data]);
  const names = useVariantNames(t, [...new Set(rows.map((r) => r.variantId))]);
  const branchName = new Map((branches.data ?? []).map((b) => [b.branchId, b.name] as const));
  const locationName = new Map(
    locations.map(
      (l) => [l.locationId, `${branchName.get(l.branchId) ?? ""} · ${l.name}`] as const,
    ),
  );

  return (
    <Stack>
      <h1>Stock gaps</h1>
      <p className={styles.muted}>
        Lines a count found short or over the thresholds. Each one needs an investigation and a
        resolution.
      </p>

      <div className={p.grid}>
        <SelectField
          label="Status"
          value={status}
          options={[
            { value: "", label: "All cases" },
            ...GAP_STATUSES.map((x) => ({ value: x, label: GAP_STATUS_LABEL[x] })),
          ]}
          onChange={(e) => {
            setStatus(e.target.value as GapStatus | "");
          }}
        />
      </div>

      {gaps.isPending ? <SkeletonRows label="Loading stock gaps" /> : null}
      {gaps.isError ? (
        isNotFound(gaps.error) ? (
          <Empty title="Stock gaps are not open to your role">
            Ask an owner to grant gap access.
          </Empty>
        ) : (
          <ErrorState
            error={gaps.error}
            onRetry={() => {
              void gaps.refetch();
            }}
          />
        )
      ) : null}
      {gaps.isSuccess && rows.length === 0 ? (
        <Empty title={status === "" ? "No stock gaps" : "No cases with this status"}>
          Cases appear after you create them from an approved stock count.
        </Empty>
      ) : null}

      {rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Stock gap cases, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Location</th>
                <th scope="col">Variance</th>
                <th scope="col" className={inv.num}>
                  Value
                </th>
                <th scope="col">Status</th>
                <th scope="col">Tasks</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const v = names.get(g.variantId);
                const title = v === undefined ? "…" : `${v.productName} · ${v.name}`;
                return (
                  <tr key={g.id}>
                    <th scope="row">
                      <Link href={`/gaps/${g.id}`}>{title}</Link>
                      <div className={styles.muted}>{assigneeText(g.assigneeId)}</div>
                    </th>
                    <td>{locationName.get(g.locationId) ?? "…"}</td>
                    <td>{gapVarianceText(g.varianceQty)}</td>
                    <td className={inv.num}>{gapValueText(g.valueMinor, g.currency)}</td>
                    <td>
                      <Badge tone={g.status === "open" ? "warning" : "neutral"}>
                        {GAP_STATUS_LABEL[g.status]}
                      </Badge>
                    </td>
                    <td>{`${String(g.openTaskCount)} open of ${String(g.taskCount)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {gaps.hasNextPage ? (
        <Button
          variant="secondary"
          busy={gaps.isFetchingNextPage}
          onClick={() => {
            void gaps.fetchNextPage();
          }}
        >
          Load more
        </Button>
      ) : null}
    </Stack>
  );
}
