"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";

import { ConfirmAction } from "@/components/confirm-action.tsx";
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
import { isNotFound, api } from "@/lib/api.ts";
import { formatPrice } from "@/lib/pricing.ts";
import {
  PO_STATUS_LABEL,
  usePos,
  useReturnFocus,
  useSupplierNames,
  useSuppliers,
  procurementKeys,
} from "@/lib/procurement.ts";
import { useProfile } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import { NewPoDialog } from "./po-dialog.tsx";
import s from "./procurement.module.css";
import { SupplierDialog } from "./supplier-dialog.tsx";

import type { PoStatus, Supplier } from "@/lib/procurement.ts";

const TABS = [
  { id: "orders", label: "Orders" },
  { id: "suppliers", label: "Suppliers" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const STATUSES: readonly PoStatus[] = [
  "draft",
  "sent",
  "partially_received",
  "received",
  "closed",
  "cancelled",
];

export default function PurchasingPage() {
  const [tab, setTab] = useState<TabId>("orders");
  return (
    <Stack>
      <Row spread>
        <h1>Purchasing</h1>
      </Row>
      <div className={s.tabs} role="tablist" aria-label="Purchasing views">
        {TABS.map((x, i) => (
          <button
            key={x.id}
            id={`purchasing-tab-${x.id}`}
            type="button"
            role="tab"
            className={s.tab}
            aria-selected={tab === x.id}
            aria-controls="purchasing-panel"
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
              document.getElementById(`purchasing-tab-${next.id}`)?.focus();
            }}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div id="purchasing-panel" role="tabpanel" aria-labelledby={`purchasing-tab-${tab}`}>
        {tab === "orders" ? <OrdersPanel /> : <SuppliersPanel />}
      </div>
    </Stack>
  );
}

/** A forbidden read answers 404 (the API hides what a role may not see), so it reads as "not available", not as a fault. */
function ListError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  if (isNotFound(error))
    return (
      <Empty title="Purchasing is not open to your role">
        Ask an owner to grant purchasing access.
      </Empty>
    );
  return <ErrorState error={error} onRetry={onRetry} />;
}

function OrdersPanel() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [status, setStatus] = useState<PoStatus | "">("");
  const [creating, setCreating] = useState(false);
  const focus = useReturnFocus();
  const orders = usePos(t, status);
  const suppliers = useSupplierNames(t);
  const rows = useMemo(() => orders.data?.pages.flatMap((p) => p.items) ?? [], [orders.data]);

  return (
    <Stack>
      <Row spread>
        <div className={s.grid}>
          <SelectField
            label="Status"
            value={status}
            options={[
              { value: "", label: "All orders" },
              ...STATUSES.map((x) => ({ value: x, label: PO_STATUS_LABEL[x] })),
            ]}
            onChange={(e) => {
              setStatus(e.target.value as PoStatus | "");
            }}
          />
        </div>
        <Button
          onClick={(e) => {
            focus.remember(e.currentTarget);
            setCreating(true);
          }}
        >
          New purchase order
        </Button>
      </Row>

      {orders.isPending ? <SkeletonRows label="Loading purchase orders" /> : null}
      {orders.isError ? (
        <ListError
          error={orders.error}
          onRetry={() => {
            void orders.refetch();
          }}
        />
      ) : null}
      {orders.isSuccess && rows.length === 0 ? (
        <Empty title="No purchase orders yet">
          Create a draft, send it to the supplier, then receive the goods against it.
        </Empty>
      ) : null}
      {rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Purchase orders, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Supplier</th>
                <th scope="col">Status</th>
                <th scope="col">Expected</th>
                <th scope="col" className={s.num}>
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((po) => (
                <tr key={po.id}>
                  <th scope="row">
                    <Link href={`/purchasing/${po.id}`}>{`PO ${String(po.poNo)}`}</Link>
                  </th>
                  <td>{suppliers.get(po.supplierId)?.name ?? "…"}</td>
                  <td>
                    <Badge tone={po.status === "draft" ? "neutral" : "accent"}>
                      {PO_STATUS_LABEL[po.status]}
                    </Badge>
                  </td>
                  <td>{po.expectedOn ?? ""}</td>
                  <td className={s.num}>{formatPrice(po.totalMinor, po.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {orders.hasNextPage ? (
        <Button
          variant="secondary"
          busy={orders.isFetchingNextPage}
          onClick={() => {
            void orders.fetchNextPage();
          }}
        >
          Load more
        </Button>
      ) : null}

      {creating ? (
        <NewPoDialog
          onClose={() => {
            setCreating(false);
            focus.restore();
          }}
        />
      ) : null}
    </Stack>
  );
}

function SuppliersPanel() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [archivedToo, setArchivedToo] = useState(false);
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);
  const [archiving, setArchiving] = useState<Supplier | null>(null);
  const focus = useReturnFocus();
  const suppliers = useSuppliers(t, archivedToo);
  const rows = useMemo(() => suppliers.data?.pages.flatMap((p) => p.items) ?? [], [suppliers.data]);
  const currency = useProfile(t).data?.currency ?? "";

  return (
    <Stack>
      <Row spread>
        <label className={s.toggle}>
          <input
            type="checkbox"
            checked={archivedToo}
            onChange={(e) => {
              setArchivedToo(e.target.checked);
            }}
          />
          Show archived suppliers
        </label>
        <Button
          onClick={(e) => {
            focus.remember(e.currentTarget);
            setEditing("new");
          }}
        >
          New supplier
        </Button>
      </Row>

      {suppliers.isPending ? <SkeletonRows label="Loading suppliers" /> : null}
      {suppliers.isError ? (
        <ListError
          error={suppliers.error}
          onRetry={() => {
            void suppliers.refetch();
          }}
        />
      ) : null}
      {suppliers.isSuccess && rows.length === 0 ? (
        <Empty title="No suppliers yet">Add a supplier before you raise a purchase order.</Empty>
      ) : null}
      {rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Suppliers</caption>
            <thead>
              <tr>
                <th scope="col">Supplier</th>
                <th scope="col">Contact</th>
                <th scope="col">Currency</th>
                <th scope="col" className={s.num}>
                  Terms (days)
                </th>
                <th scope="col" className={s.num}>
                  Lead time (days)
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id}>
                  <th scope="row">
                    {x.name} {x.archivedAt === null ? null : <Badge>Archived</Badge>}
                  </th>
                  <td>{x.contactName}</td>
                  <td>{x.currency}</td>
                  <td className={s.num}>{String(x.paymentTermsDays)}</td>
                  <td className={s.num}>{String(x.leadTimeDays)}</td>
                  <td>
                    <div className={s.actions}>
                      {x.archivedAt === null ? (
                        <>
                          <Button
                            variant="ghost"
                            aria-label={`Edit ${x.name}`}
                            onClick={(e) => {
                              focus.remember(e.currentTarget);
                              setEditing(x);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            aria-label={`Archive ${x.name}`}
                            onClick={(e) => {
                              focus.remember(e.currentTarget);
                              setArchiving(x);
                            }}
                          >
                            Archive
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {suppliers.hasNextPage ? (
        <Button
          variant="secondary"
          busy={suppliers.isFetchingNextPage}
          onClick={() => {
            void suppliers.fetchNextPage();
          }}
        >
          Load more
        </Button>
      ) : null}

      {editing === null ? null : (
        <SupplierDialog
          supplier={editing === "new" ? undefined : editing}
          defaultCurrency={currency}
          onClose={() => {
            setEditing(null);
            focus.restore();
          }}
        />
      )}
      {archiving === null ? null : (
        <ArchiveSupplier
          supplier={archiving}
          onClose={() => {
            setArchiving(null);
            focus.restore();
          }}
        />
      )}
    </Stack>
  );
}

function ArchiveSupplier({
  supplier,
  onClose,
}: {
  readonly supplier: Supplier;
  readonly onClose: () => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  return (
    <ConfirmAction
      title={`Archive ${supplier.name}?`}
      confirmLabel="Archive supplier"
      danger
      onClose={onClose}
      run={async (key) => {
        await api("POST", `/v1/procurement/suppliers/${encodeURIComponent(supplier.id)}/archive`, {
          body: { version: supplier.version },
          idempotencyKey: key,
        });
        await qc.invalidateQueries({ queryKey: procurementKeys.all(t) });
      }}
    >
      <p>No new purchase orders or prices for this supplier. Its history stays.</p>
    </ConfirmAction>
  );
}
