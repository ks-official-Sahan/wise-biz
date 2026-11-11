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
import { COUNT_STATUS_LABEL, COUNT_STATUSES, countProgressText, useCounts } from "@/lib/counts.ts";
import { useReturnFocus, useAllLocations } from "@/lib/procurement.ts";
import { useBranches } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../inventory.module.css";
import p from "../purchasing/procurement.module.css";

import { NewCountDialog } from "./new-count-dialog.tsx";

import type { CountStatus } from "@/lib/counts.ts";

export default function CountsPage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [status, setStatus] = useState<CountStatus | "">("");
  const [creating, setCreating] = useState(false);
  const focus = useReturnFocus();
  const counts = useCounts(t, status);
  const branches = useBranches(t);
  const branchIds = useMemo(
    () => (branches.data ?? []).filter((b) => !b.archived).map((b) => b.branchId),
    [branches.data],
  );
  const locations = useAllLocations(t, branchIds);
  const rows = useMemo(() => counts.data?.pages.flatMap((p) => p.items) ?? [], [counts.data]);
  const branchName = new Map((branches.data ?? []).map((b) => [b.branchId, b.name] as const));
  const locationName = new Map(
    locations.map(
      (l) => [l.locationId, `${branchName.get(l.branchId) ?? ""} · ${l.name}`] as const,
    ),
  );

  return (
    <Stack>
      <Row spread>
        <h1>Stock counts</h1>
        <Button
          onClick={(e) => {
            focus.remember(e.currentTarget);
            setCreating(true);
          }}
        >
          New count
        </Button>
      </Row>

      <div className={p.grid}>
        <SelectField
          label="Status"
          value={status}
          options={[
            { value: "", label: "All counts" },
            ...COUNT_STATUSES.map((x) => ({ value: x, label: COUNT_STATUS_LABEL[x] })),
          ]}
          onChange={(e) => {
            setStatus(e.target.value as CountStatus | "");
          }}
        />
      </div>

      {counts.isPending ? <SkeletonRows label="Loading stock counts" /> : null}
      {counts.isError ? (
        isNotFound(counts.error) ? (
          <Empty title="Stock counts are not open to your role">
            Ask an owner to grant count access.
          </Empty>
        ) : (
          <ErrorState
            error={counts.error}
            onRetry={() => {
              void counts.refetch();
            }}
          />
        )
      ) : null}
      {counts.isSuccess && rows.length === 0 ? (
        <Empty
          title={status === "" ? "No stock counts yet" : "No counts with this status"}
          action={
            status === "" ? (
              <Button
                variant="secondary"
                onClick={(e) => {
                  focus.remember(e.currentTarget);
                  setCreating(true);
                }}
              >
                New count
              </Button>
            ) : null
          }
        >
          Start a count to check the shelves against the system. Nothing changes until a count is
          approved.
        </Empty>
      ) : null}

      {rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Stock counts, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Count</th>
                <th scope="col">Location</th>
                <th scope="col">Status</th>
                <th scope="col">Progress</th>
                <th scope="col">Opened</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <th scope="row">
                    <Link href={`/counts/${c.id}`}>
                      {`${c.kind === "full" ? "Full" : "Cycle"} count`}
                    </Link>
                    <div className={styles.muted}>
                      {[c.mode === "frozen" ? "Frozen" : "Live", c.blind ? "blind" : null]
                        .filter(Boolean)
                        .join(", ")}
                    </div>
                  </th>
                  <td>{locationName.get(c.locationId) ?? "…"}</td>
                  <td>
                    <Badge tone={c.status === "review" ? "accent" : "neutral"}>
                      {COUNT_STATUS_LABEL[c.status]}
                    </Badge>
                  </td>
                  <td>{countProgressText(c)}</td>
                  <td className={s.num}>{c.openedAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {counts.hasNextPage ? (
        <Button
          variant="secondary"
          busy={counts.isFetchingNextPage}
          onClick={() => {
            void counts.fetchNextPage();
          }}
        >
          Load more
        </Button>
      ) : null}

      {creating ? (
        <NewCountDialog
          onClose={() => {
            setCreating(false);
            focus.restore();
          }}
        />
      ) : null}
    </Stack>
  );
}
