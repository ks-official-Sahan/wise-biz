"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Alert, Button, Dialog, Row, SelectField, Stack, TextField } from "@/components/ui.tsx";
import { VariantPicker } from "@/components/variant-picker.tsx";
import { api } from "@/lib/api.ts";
import { newId } from "@/lib/pricing.ts";
import {
  actionErrorText,
  buildTransfer,
  procurementKeys,
  useAllLocations,
  useAttemptKey,
} from "@/lib/procurement.ts";
import { useBranches } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../purchasing/procurement.module.css";

import type { Hit } from "@/components/variant-picker.tsx";
import type { Transfer, TransferForm } from "@/lib/procurement.ts";
import type { SubmitEvent } from "react";

interface Draft {
  readonly key: string;
  readonly variantId: string;
  readonly qty: string;
}

/** Request a transfer between two locations. Nothing moves until it is dispatched. */
export function NewTransferDialog({ onClose }: { readonly onClose: () => void }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const router = useRouter();
  const keyFor = useAttemptKey();
  const branches = useBranches(t);
  const activeBranches = useMemo(
    () => (branches.data ?? []).filter((b) => !b.archived),
    [branches.data],
  );
  const locations = useAllLocations(
    t,
    activeBranches.map((b) => b.branchId),
  );
  const options = useMemo(() => {
    const names = new Map(activeBranches.map((b) => [b.branchId, b.name] as const));
    return locations
      .filter((l) => !l.archived)
      .map((l) => ({ value: l.locationId, label: `${names.get(l.branchId) ?? ""} · ${l.name}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [locations, activeBranches]);

  const [fromLocationId, setFrom] = useState("");
  const [toLocationId, setTo] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<readonly Draft[]>([]);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = (h: Hit) => {
    setTitles((cur) => new Map(cur).set(h.variantId, h.title));
    setLines((cur) => [...cur, { key: newId(), variantId: h.variantId, qty: "" }]);
  };

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const form: TransferForm = { fromLocationId, toLocationId, notes, lines };
    const built = buildTransfer(form);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors(new Map());
    setBusy(true);
    setError(null);
    try {
      const created = await api<Transfer>("POST", "/v1/procurement/transfers", {
        body: built.body,
        idempotencyKey: keyFor(JSON.stringify(built.body)),
      });
      await qc.invalidateQueries({ queryKey: procurementKeys.all(t) });
      onClose();
      router.push(`/transfers/${created.id}`);
    } catch (err) {
      setError(actionErrorText(err, "Could not request the transfer. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="New transfer" onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <div className={s.grid}>
          <SelectField
            label="From"
            value={fromLocationId}
            error={errors.get("fromLocationId")}
            options={[{ value: "", label: "Pick a location" }, ...options]}
            onChange={(e) => {
              setFrom(e.target.value);
            }}
          />
          <SelectField
            label="To"
            value={toLocationId}
            error={errors.get("toLocationId")}
            options={[{ value: "", label: "Pick a location" }, ...options]}
            onChange={(e) => {
              setTo(e.target.value);
            }}
          />
        </div>
        <TextField
          label="Notes (optional)"
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
          }}
        />
        <VariantPicker label="Add a product" onPick={add} />
        {errors.get("lines") === undefined ? null : <p role="alert">{errors.get("lines")}</p>}
        {lines.map((l) => {
          const title = titles.get(l.variantId) ?? "Product";
          return (
            <fieldset key={l.key} className={s.line}>
              <legend>{title}</legend>
              <TextField
                label="Quantity to move"
                inputMode="decimal"
                value={l.qty}
                error={errors.get(`${l.key}.qty`) ?? errors.get(`${l.key}.variantId`)}
                onChange={(e) => {
                  const qty = e.target.value;
                  setLines((cur) => cur.map((x) => (x.key === l.key ? { ...x, qty } : x)));
                }}
              />
              <div className={s.lineActions}>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setLines((cur) => cur.filter((x) => x.key !== l.key));
                  }}
                >
                  {`Remove ${title}`}
                </Button>
              </div>
            </fieldset>
          );
        })}
        <Stack>
          <Row spread>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={busy} disabled={lines.length === 0}>
              Request transfer
            </Button>
          </Row>
        </Stack>
      </form>
    </Dialog>
  );
}
