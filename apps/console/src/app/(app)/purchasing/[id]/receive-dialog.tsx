"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Alert, Button, Dialog, Row, TextField } from "@/components/ui.tsx";
import { api } from "@/lib/api.ts";
import {
  actionErrorText,
  buildLineQty,
  openQty,
  overReceiptHint,
  procurementKeys,
  useAttemptKey,
} from "@/lib/procurement.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../procurement.module.css";

import type { PurchaseOrder } from "@/lib/procurement.ts";
import type { SubmitEvent } from "react";

/**
 * Receive against a PO: a quantity per line, blanks left out. Over-receipt is a hint beside the line; the server
 * applies the tolerance and refuses what it must.
 */
export function ReceivePoDialog({
  po,
  titles,
  onClose,
}: {
  readonly po: PurchaseOrder;
  readonly titles: ReadonlyMap<string, string>;
  readonly onClose: () => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const keyFor = useAttemptKey();
  const [reference, setReference] = useState("");
  const [values, setValues] = useState<ReadonlyMap<number, string>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const built = buildLineQty(
      po.lines.map((l) => ({ line: l.line, value: values.get(l.line) ?? "" })),
      { allowZero: false, skipBlank: true },
    );
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors(new Map());
    setBusy(true);
    setError(null);
    const body = {
      ...(reference.trim() === "" ? {} : { reference: reference.trim() }),
      lines: built.body,
    };
    try {
      await api("POST", `/v1/procurement/purchase-orders/${encodeURIComponent(po.id)}/receive`, {
        body,
        idempotencyKey: keyFor(`${po.id}|${JSON.stringify(body)}`),
      });
      await qc.invalidateQueries({ queryKey: procurementKeys.all(t) });
      onClose();
    } catch (err) {
      setError(actionErrorText(err, "Could not record the receipt. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title={`Receive against PO ${String(po.poNo)}`} onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <TextField
          label="Reference (optional)"
          value={reference}
          help="Supplier delivery note or invoice number."
          onChange={(e) => {
            setReference(e.target.value);
          }}
        />
        {errors.get("lines") === undefined ? null : (
          <Alert tone="danger">{errors.get("lines")}</Alert>
        )}
        {po.lines.map((l) => {
          const value = values.get(l.line) ?? "";
          const open = openQty(l.orderedQty, l.receivedQty);
          const hint = overReceiptHint(l.orderedQty, l.receivedQty, value);
          return (
            <fieldset key={l.line} className={s.line}>
              <legend>{titles.get(l.variantId) ?? "Product"}</legend>
              <p className={s.hint}>
                {`Ordered ${l.orderedQty}, received ${l.receivedQty}, open ${open}`}
              </p>
              <TextField
                label="Quantity received now"
                inputMode="decimal"
                value={value}
                help={hint ?? undefined}
                error={errors.get(`line-${String(l.line)}`)}
                onChange={(e) => {
                  const next = e.target.value;
                  setValues((cur) => new Map(cur).set(l.line, next));
                }}
              />
            </fieldset>
          );
        })}
        <Row spread>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Record receipt
          </Button>
        </Row>
      </form>
    </Dialog>
  );
}
