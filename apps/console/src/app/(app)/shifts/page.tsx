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
  TextField,
  styles,
} from "@/components/ui.tsx";
import { formatPrice } from "@/lib/pricing.ts";
import { useBranches } from "@/lib/queries.ts";
import { useShifts, variance } from "@/lib/sales.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../ops.module.css";

import type { ShiftsFilter } from "@/lib/sales.ts";

export default function ShiftsPage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const branches = useBranches(t);
  const [filter, setFilter] = useState<ShiftsFilter>({});
  const shifts = useShifts(t, filter);
  const rows = useMemo(() => shifts.data?.pages.flatMap((p) => p.items) ?? [], [shifts.data]);
  const branchName = new Map((branches.data ?? []).map((b) => [b.branchId, b.name]));
  const set = (patch: Partial<ShiftsFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
  };

  return (
    <Stack>
      <Row spread>
        <h1>Shifts</h1>
      </Row>
      <div className={s.grid}>
        <SelectField
          label="Branch"
          value={filter.branchId ?? ""}
          options={[
            { value: "", label: "All branches" },
            ...(branches.data ?? []).map((b) => ({ value: b.branchId, label: b.name })),
          ]}
          onChange={(e) => {
            set({ branchId: e.target.value === "" ? undefined : e.target.value });
          }}
        />
        <SelectField
          label="Status"
          value={filter.status ?? ""}
          options={[
            { value: "", label: "Open and closed" },
            { value: "open", label: "Open now" },
            { value: "closed", label: "Closed" },
          ]}
          onChange={(e) => {
            set({
              status: e.target.value === "" ? undefined : (e.target.value as "open" | "closed"),
            });
          }}
        />
        <TextField
          label="From"
          type="date"
          value={filter.from ?? ""}
          onChange={(e) => {
            set({ from: e.target.value === "" ? undefined : e.target.value });
          }}
        />
        <TextField
          label="To"
          type="date"
          value={filter.to ?? ""}
          onChange={(e) => {
            set({ to: e.target.value === "" ? undefined : e.target.value });
          }}
        />
      </div>

      {shifts.isPending ? <SkeletonRows label="Loading shifts" /> : null}
      {shifts.isError ? (
        <ErrorState
          error={shifts.error}
          onRetry={() => {
            void shifts.refetch();
          }}
        />
      ) : null}
      {shifts.isSuccess && rows.length === 0 ? (
        <Empty title="No shifts found">Shifts appear when a terminal opens its till.</Empty>
      ) : null}
      {rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Shifts, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Opened</th>
                <th scope="col">Branch</th>
                <th scope="col">Status</th>
                <th scope="col" className={s.num}>
                  Over / short
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const v = variance(r.overShortMinor);
                return (
                  <tr key={r.id}>
                    <th scope="row">
                      <Link href={`/shifts/${r.id}`}>{new Date(r.openedAt).toLocaleString()}</Link>
                    </th>
                    <td>{branchName.get(r.branchId) ?? "…"}</td>
                    <td>
                      {r.status === "open" ? (
                        <Badge tone="accent">Open</Badge>
                      ) : (
                        <Badge>Closed</Badge>
                      )}
                    </td>
                    <td className={s.num}>
                      {r.overShortMinor === null ? (
                        ""
                      ) : v === "balanced" ? (
                        "Balanced"
                      ) : (
                        <Badge tone="warning">
                          {`${v === "over" ? "Over" : "Short"} ${formatPrice(Math.abs(r.overShortMinor), r.currency)}`}
                        </Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {shifts.hasNextPage ? (
        <Button
          variant="secondary"
          busy={shifts.isFetchingNextPage}
          onClick={() => {
            void shifts.fetchNextPage();
          }}
        >
          Load more
        </Button>
      ) : null}
    </Stack>
  );
}
