"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Alert, Button, Dialog, Row, SelectField, TextField } from "@/components/ui.tsx";
import { VariantPicker } from "@/components/variant-picker.tsx";
import { api } from "@/lib/api.ts";
import { newId } from "@/lib/pricing.ts";
import {
  actionErrorText,
  buildPo,
  procurementKeys,
  useAttemptKey,
  useSupplierNames,
} from "@/lib/procurement.ts";
import { useBranches, useLocations } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./procurement.module.css";

import type { Hit } from "@/components/variant-picker.tsx";
import type { DraftLine, PoForm, PurchaseOrder } from "@/lib/procurement.ts";
import type { SubmitEvent } from "react";

const EMPTY: PoForm = {
  supplierId: "",
  branchId: "",
  locationId: "",
  expectedOn: "",
  notes: "",
  lines: [],
};

/** New draft purchase order. Unit costs are in the supplier's currency. Creating it opens the draft. */
export function NewPoDialog({ onClose }: { readonly onClose: () => void }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const router = useRouter();
  const keyFor = useAttemptKey();
  const suppliers = useSupplierNames(t);
  const branches = useBranches(t);
  const [form, setForm] = useState<PoForm>(EMPTY);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeSuppliers = useMemo(
    () =>
      [...suppliers.values()]
        .filter((x) => x.archivedAt === null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [suppliers],
  );
  const supplier = suppliers.get(form.supplierId);
  const currency = supplier?.currency ?? "";
  const activeBranches = (branches.data ?? []).filter((b) => !b.archived);
  const branchId = form.branchId !== "" ? form.branchId : (activeBranches[0]?.branchId ?? "");
  const locations = useLocations(t, branchId === "" ? null : branchId);
  const activeLocations = (locations.data ?? []).filter((l) => !l.archived);
  const locationId = activeLocations.some((l) => l.locationId === form.locationId)
    ? form.locationId
    : (activeLocations[0]?.locationId ?? "");

  const patch = (p: Partial<PoForm>) => {
    setForm((f) => ({ ...f, ...p }));
  };
  const patchLine = (key: string, p: Partial<DraftLine>) => {
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) }));
  };
  const addLine = (h: Hit) => {
    setTitles((cur) => new Map(cur).set(h.variantId, h.title));
    setForm((f) => ({
      ...f,
      lines: [...f.lines, { key: newId(), variantId: h.variantId, qty: "", cost: "" }],
    }));
  };

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const built = buildPo({ ...form, branchId, locationId }, currency);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors(new Map());
    setBusy(true);
    setError(null);
    try {
      const created = await api<PurchaseOrder>("POST", "/v1/procurement/purchase-orders", {
        body: built.body,
        idempotencyKey: keyFor(JSON.stringify(built.body)),
      });
      await qc.invalidateQueries({ queryKey: procurementKeys.all(t) });
      onClose();
      router.push(`/purchasing/${created.id}`);
    } catch (err) {
      setError(actionErrorText(err, "Could not create the order. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="New purchase order" onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <SelectField
          label="Supplier"
          value={form.supplierId}
          error={errors.get("supplierId")}
          options={[
            {
              value: "",
              label: activeSuppliers.length === 0 ? "No suppliers yet" : "Pick a supplier",
            },
            ...activeSuppliers.map((x) => ({ value: x.id, label: `${x.name} (${x.currency})` })),
          ]}
          onChange={(e) => {
            patch({ supplierId: e.target.value });
          }}
        />
        <div className={s.grid}>
          <SelectField
            label="Branch"
            value={branchId}
            options={activeBranches.map((b) => ({ value: b.branchId, label: b.name }))}
            onChange={(e) => {
              patch({ branchId: e.target.value, locationId: "" });
            }}
          />
          <SelectField
            label="Receive into"
            value={locationId}
            error={errors.get("locationId")}
            options={activeLocations.map((l) => ({ value: l.locationId, label: l.name }))}
            onChange={(e) => {
              patch({ locationId: e.target.value });
            }}
          />
        </div>
        <TextField
          label="Expected on (optional)"
          type="date"
          value={form.expectedOn}
          error={errors.get("expectedOn")}
          onChange={(e) => {
            patch({ expectedOn: e.target.value });
          }}
        />
        <TextField
          label="Notes (optional)"
          value={form.notes}
          onChange={(e) => {
            patch({ notes: e.target.value });
          }}
        />
        <VariantPicker label="Add a product" onPick={addLine} />
        {errors.get("lines") === undefined ? null : <p role="alert">{errors.get("lines")}</p>}
        {form.lines.map((l) => {
          const title = titles.get(l.variantId) ?? "Product";
          return (
            <fieldset key={l.key} className={s.line}>
              <legend>{title}</legend>
              <TextField
                label="Quantity ordered"
                inputMode="decimal"
                value={l.qty}
                error={errors.get(`${l.key}.qty`) ?? errors.get(`${l.key}.variantId`)}
                onChange={(e) => {
                  patchLine(l.key, { qty: e.target.value });
                }}
              />
              <TextField
                label={currency === "" ? "Unit cost" : `Unit cost (${currency})`}
                inputMode="decimal"
                value={l.cost}
                error={errors.get(`${l.key}.cost`)}
                onChange={(e) => {
                  patchLine(l.key, { cost: e.target.value });
                }}
              />
              <div className={s.lineActions}>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setForm((f) => ({ ...f, lines: f.lines.filter((x) => x.key !== l.key) }));
                  }}
                >
                  {`Remove ${title}`}
                </Button>
              </div>
            </fieldset>
          );
        })}
        <Row spread>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={form.lines.length === 0}>
            Create draft order
          </Button>
        </Row>
      </form>
    </Dialog>
  );
}
