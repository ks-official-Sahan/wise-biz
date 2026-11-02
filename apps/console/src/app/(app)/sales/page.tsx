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
import { flagLabel, useSales } from "@/lib/sales.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../ops.module.css";

import type { SalesFilter } from "@/lib/sales.ts";

export default function SalesPage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const branches = useBranches(t);
  const [filter, setFilter] = useState<SalesFilter>({});
  const sales = useSales(t, filter);
  const rows = useMemo(() => sales.data?.pages.flatMap((p) => p.items) ?? [], [sales.data]);
  const branchName = new Map((branches.data ?? []).map((b) => [b.branchId, b.name]));
  const set = (patch: Partial<SalesFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
  };

  return (
    <Stack>
      <Row spread>
        <h1>Sales</h1>
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
            { value: "", label: "All sales" },
            { value: "completed", label: "Completed" },
            { value: "voided", label: "Voided" },
          ]}
          onChange={(e) => {
            set({
              status:
                e.target.value === "" ? undefined : (e.target.value as "completed" | "voided"),
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
        <SelectField
          label="Review"
          value={filter.flagged === true ? "flagged" : ""}
          options={[
            { value: "", label: "All sales" },
            { value: "flagged", label: "Needs review" },
          ]}
          onChange={(e) => {
            set({ flagged: e.target.value === "flagged" ? true : undefined });
          }}
        />
      </div>

      {sales.isPending ? <SkeletonRows label="Loading sales" /> : null}
      {sales.isError ? (
        <ErrorState
          error={sales.error}
          onRetry={() => {
            void sales.refetch();
          }}
        />
      ) : null}
      {sales.isSuccess && rows.length === 0 ? (
        <Empty title="No sales found">Try another date range or filter.</Empty>
      ) : null}
      {rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Sales, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Sale</th>
                <th scope="col">When</th>
                <th scope="col">Branch</th>
                <th scope="col" className={s.num}>
                  Total
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    <Link href={`/sales/${r.id}`}>{`#${String(r.saleNo)}`}</Link>
                    {r.invoiceNo === null ? null : (
                      <span className={styles.muted}>{` · ${r.invoiceNo}`}</span>
                    )}
                  </th>
                  <td>{new Date(r.completedAt).toLocaleString()}</td>
                  <td>{branchName.get(r.branchId) ?? "…"}</td>
                  <td className={s.num}>{formatPrice(r.payableMinor, r.currency)}</td>
                  <td>
                    <span className={s.flags}>
                      {r.status === "voided" ? (
                        <Badge tone="warning">Voided</Badge>
                      ) : (
                        <Badge>Completed</Badge>
                      )}
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
      {sales.hasNextPage ? (
        <Button
          variant="secondary"
          busy={sales.isFetchingNextPage}
          onClick={() => {
            void sales.fetchNextPage();
          }}
        >
          Load more
        </Button>
      ) : null}
    </Stack>
  );
}
