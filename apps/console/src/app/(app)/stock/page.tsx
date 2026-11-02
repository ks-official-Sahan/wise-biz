"use client";

import { useMemo, useState } from "react";

import {
  Badge,
  Button,
  Empty,
  ErrorState,
  LinkButton,
  Row,
  SelectField,
  SkeletonRows,
  Stack,
  styles,
} from "@/components/ui.tsx";
import { daysUntil, expiryCutoff, useBalances, useThresholds } from "@/lib/inventory.ts";
import { useVariantNames } from "@/lib/pricing.ts";
import { useBranches, useLocations } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import { AdjustDialog } from "./adjust-dialog.tsx";
import { ReceiveDialog } from "./receive-dialog.tsx";
import s from "./stock.module.css";

const TABS = [
  { id: "stock", label: "On hand" },
  { id: "low", label: "Low stock" },
  { id: "expiring", label: "Expiring soon" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const EXPIRY_DAYS = 30;

export default function StockPage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const branches = useBranches(t);
  const [branchPick, setBranchPick] = useState("");
  const branchId =
    branchPick !== "" ? branchPick : (branches.data?.find((b) => !b.archived)?.branchId ?? "");
  const locations = useLocations(t, branchId === "" ? null : branchId);
  const [locationPick, setLocationPick] = useState("");
  const activeLocations = useMemo(
    () => (locations.data ?? []).filter((l) => !l.archived),
    [locations.data],
  );
  const locationId = activeLocations.some((l) => l.locationId === locationPick)
    ? locationPick
    : (activeLocations[0]?.locationId ?? "");
  const [tab, setTab] = useState<TabId>("stock");
  const [dialog, setDialog] = useState<"receive" | "adjust" | null>(null);

  return (
    <Stack>
      <Row spread>
        <h1>Stock</h1>
        <Row>
          <LinkButton variant="secondary" href="/stock/labels">
            Print labels
          </LinkButton>
          <Button
            variant="secondary"
            disabled={locationId === ""}
            onClick={() => {
              setDialog("adjust");
            }}
          >
            Adjust stock
          </Button>
          <Button
            disabled={locationId === ""}
            onClick={() => {
              setDialog("receive");
            }}
          >
            Receive stock
          </Button>
        </Row>
      </Row>

      <div className={s.grid}>
        <SelectField
          label="Branch"
          value={branchId}
          options={(branches.data ?? [])
            .filter((b) => !b.archived)
            .map((b) => ({ value: b.branchId, label: b.name }))}
          onChange={(e) => {
            setBranchPick(e.target.value);
            setLocationPick("");
          }}
        />
        <SelectField
          label="Location"
          value={locationId}
          options={activeLocations.map((l) => ({ value: l.locationId, label: l.name }))}
          onChange={(e) => {
            setLocationPick(e.target.value);
          }}
        />
      </div>

      {branches.isError ? (
        <ErrorState
          error={branches.error}
          onRetry={() => {
            void branches.refetch();
          }}
        />
      ) : null}
      {branches.isSuccess && locationId === "" && !(branchId !== "" && locations.isPending) ? (
        <Empty title="No stock location">
          Add a branch with a location in Settings before you receive stock.
        </Empty>
      ) : null}

      {locationId === "" ? null : (
        <>
          <div className={s.tabs} role="tablist" aria-label="Stock views">
            {TABS.map((x, i) => (
              <button
                key={x.id}
                id={`stock-tab-${x.id}`}
                type="button"
                role="tab"
                className={s.tab}
                aria-selected={tab === x.id}
                aria-controls={tab === x.id ? "stock-panel" : undefined}
                tabIndex={tab === x.id ? 0 : -1}
                onClick={() => {
                  setTab(x.id);
                }}
                onKeyDown={(e) => {
                  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                  if (step === 0) return;
                  const next = TABS[(i + step + TABS.length) % TABS.length];
                  if (next === undefined) return;
                  setTab(next.id);
                  document.getElementById(`stock-tab-${next.id}`)?.focus();
                }}
              >
                {x.label}
              </button>
            ))}
          </div>
          <div id="stock-panel" role="tabpanel" aria-labelledby={`stock-tab-${tab}`}>
            {tab === "stock" ? <OnHand locationId={locationId} expiring={false} /> : null}
            {tab === "low" ? <LowStock locationId={locationId} /> : null}
            {tab === "expiring" ? <OnHand locationId={locationId} expiring /> : null}
          </div>
        </>
      )}

      {dialog === "receive" && locationId !== "" ? (
        <ReceiveDialog
          locationId={locationId}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === "adjust" && locationId !== "" ? (
        <AdjustDialog
          locationId={locationId}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
    </Stack>
  );
}

function OnHand({ locationId, expiring }: { locationId: string; expiring: boolean }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [cutoff] = useState(() => expiryCutoff(EXPIRY_DAYS));
  const pages = useBalances(t, locationId, expiring ? cutoff : null);
  const rows = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const names = useVariantNames(t, [...new Set(rows.map((r) => r.variantId))]);

  if (pages.isPending) return <SkeletonRows label="Loading stock" />;
  if (pages.isError)
    return (
      <ErrorState
        error={pages.error}
        onRetry={() => {
          void pages.refetch();
        }}
      />
    );
  if (rows.length === 0)
    return expiring ? (
      <Empty title="Nothing expiring">{`No batches expire in the next ${String(EXPIRY_DAYS)} days.`}</Empty>
    ) : (
      <Empty title="No stock here yet">Receive stock to see it on this list.</Empty>
    );

  return (
    <Stack>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">
            {expiring ? "Batches expiring soon" : "Stock on hand"}
          </caption>
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">SKU</th>
              {expiring ? (
                <>
                  <th scope="col">Lot</th>
                  <th scope="col">Expires</th>
                </>
              ) : null}
              <th scope="col" className={s.num}>
                On hand
              </th>
              <th scope="col" className={s.num}>
                Available
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const n = names.get(r.variantId);
              const days = r.expiresOn == null ? null : daysUntil(r.expiresOn);
              return (
                <tr key={`${r.variantId}|${r.batchId ?? ""}`}>
                  <th scope="row">{n === undefined ? "…" : `${n.productName} · ${n.name}`}</th>
                  <td>{n?.sku ?? ""}</td>
                  {expiring ? (
                    <>
                      <td>{r.lotCode ?? ""}</td>
                      <td>
                        {r.expiresOn ?? ""}{" "}
                        {days === null ? null : days < 0 ? (
                          <Badge tone="warning">Expired</Badge>
                        ) : (
                          <Badge tone="warning">{`${String(days)} days`}</Badge>
                        )}
                      </td>
                    </>
                  ) : null}
                  <td className={s.num}>{r.qty}</td>
                  <td className={s.num}>{r.available}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pages.hasNextPage ? (
        <Button
          variant="secondary"
          busy={pages.isFetchingNextPage}
          onClick={() => {
            void pages.fetchNextPage();
          }}
        >
          Load more
        </Button>
      ) : null}
    </Stack>
  );
}

function LowStock({ locationId }: { locationId: string }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const thresholds = useThresholds(t, locationId);
  const low = useMemo(
    () => (thresholds.data ?? []).filter((x) => x.lowSince !== null),
    [thresholds.data],
  );
  const names = useVariantNames(
    t,
    low.map((x) => x.variantId),
  );

  if (thresholds.isPending) return <SkeletonRows label="Loading low stock" rows={3} />;
  if (thresholds.isError)
    return (
      <ErrorState
        error={thresholds.error}
        onRetry={() => {
          void thresholds.refetch();
        }}
      />
    );
  if (low.length === 0)
    return <Empty title="Nothing is low">Products below their minimum show up here.</Empty>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="sr-only">Low stock</caption>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">SKU</th>
            <th scope="col" className={s.num}>
              Minimum
            </th>
            <th scope="col">Low since</th>
          </tr>
        </thead>
        <tbody>
          {low.map((x) => {
            const n = names.get(x.variantId);
            return (
              <tr key={x.variantId}>
                <th scope="row">{n === undefined ? "…" : `${n.productName} · ${n.name}`}</th>
                <td>{n?.sku ?? ""}</td>
                <td className={s.num}>{x.minQty}</td>
                <td>{x.lowSince === null ? "" : new Date(x.lowSince).toLocaleDateString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
