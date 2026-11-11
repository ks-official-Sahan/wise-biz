"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Alert, Button, Dialog, Row, Stack, TextField } from "@/components/ui.tsx";
import { api } from "@/lib/api.ts";
import {
  actionErrorText,
  buildSupplier,
  procurementKeys,
  useAttemptKey,
} from "@/lib/procurement.ts";
import { useTenant } from "@/lib/tenant.tsx";

import type { Supplier, SupplierForm } from "@/lib/procurement.ts";
import type { SubmitEvent } from "react";

const blank: SupplierForm = {
  name: "",
  contactName: "",
  email: "",
  phone: "",
  address: "",
  paymentTermsDays: "0",
  leadTimeDays: "0",
  currency: "",
};

/** Create a supplier, or edit one (optimistic version; currency is fixed once the supplier exists). */
export function SupplierDialog({
  supplier,
  defaultCurrency,
  onClose,
}: {
  readonly supplier?: Supplier | undefined;
  readonly defaultCurrency: string;
  readonly onClose: () => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const keyFor = useAttemptKey();
  const [form, setForm] = useState<SupplierForm>(() =>
    supplier === undefined
      ? { ...blank, currency: defaultCurrency }
      : {
          name: supplier.name,
          contactName: supplier.contactName,
          email: supplier.email,
          phone: supplier.phone,
          address: supplier.address,
          paymentTermsDays: String(supplier.paymentTermsDays),
          leadTimeDays: String(supplier.leadTimeDays),
          currency: supplier.currency,
        },
  );
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof SupplierForm) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const built = buildSupplier(form);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors(new Map());
    setBusy(true);
    setError(null);
    try {
      const body = built.body;
      if (supplier === undefined) {
        const sig = JSON.stringify(body);
        await api("POST", "/v1/procurement/suppliers", {
          body,
          idempotencyKey: keyFor(`create|${sig}`),
        });
      } else {
        const sig = JSON.stringify({ ...body, version: supplier.version });
        await api("PUT", `/v1/procurement/suppliers/${encodeURIComponent(supplier.id)}`, {
          body: { ...body, version: supplier.version },
          idempotencyKey: keyFor(`update|${supplier.id}|${sig}`),
        });
      }
      await qc.invalidateQueries({ queryKey: procurementKeys.all(t) });
      onClose();
    } catch (err) {
      setError(actionErrorText(err, "Could not save the supplier. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const title = supplier === undefined ? "New supplier" : `Edit ${supplier.name}`;
  return (
    <Dialog open title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <Stack>
          {error === null ? null : <Alert tone="danger">{error}</Alert>}
          <TextField
            label="Supplier name"
            required
            value={form.name}
            error={errors.get("name")}
            onChange={set("name")}
          />
          <TextField label="Contact name" value={form.contactName} onChange={set("contactName")} />
          <TextField
            label="Email"
            type="email"
            value={form.email}
            error={errors.get("email")}
            onChange={set("email")}
          />
          <TextField label="Phone" type="tel" value={form.phone} onChange={set("phone")} />
          <TextField label="Address" value={form.address} onChange={set("address")} />
          <TextField
            label="Payment terms (days)"
            inputMode="numeric"
            value={form.paymentTermsDays}
            error={errors.get("paymentTermsDays")}
            onChange={set("paymentTermsDays")}
          />
          <TextField
            label="Lead time (days)"
            inputMode="numeric"
            value={form.leadTimeDays}
            error={errors.get("leadTimeDays")}
            onChange={set("leadTimeDays")}
          />
          {supplier === undefined ? (
            <TextField
              label="Currency (ISO 4217)"
              value={form.currency}
              help="Every order and price for this supplier uses this currency."
              error={errors.get("currency")}
              onChange={set("currency")}
            />
          ) : (
            <TextField
              label="Currency (ISO 4217)"
              value={form.currency}
              readOnly
              help="Fixed once the supplier exists."
            />
          )}
          <Row spread>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={busy}>
              {supplier === undefined ? "Create supplier" : "Save supplier"}
            </Button>
          </Row>
        </Stack>
      </form>
    </Dialog>
  );
}
