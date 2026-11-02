"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { Alert, Button, Dialog, Row, Stack, TextField } from "@/components/ui.tsx";
import { VariantPicker } from "@/components/variant-picker.tsx";
import { api } from "@/lib/api.ts";
import { buildReceive, stockKeys } from "@/lib/inventory.ts";
import { newId } from "@/lib/pricing.ts";
import { useProfile } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./stock.module.css";

import type { Hit } from "@/components/variant-picker.tsx";
import type { ReceiveLineDraft } from "@/lib/inventory.ts";
import type { SubmitEvent } from "react";

export function ReceiveDialog({
  locationId,
  onClose,
}: {
  locationId: string;
  onClose: () => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const currency = useProfile(t).data?.currency ?? "";
  // One id per dialog: a retry after a lost response replays the receipt instead of receiving twice.
  // The key follows the payload: a retry of the same body replays, a changed body is a new request.
  const attempt = useRef<{ id: string; sig: string } | null>(null);
  const keyFor = (sig: string): string => {
    if (attempt.current?.sig !== sig) attempt.current = { id: newId(), sig };
    return attempt.current.id;
  };
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<readonly ReceiveLineDraft[]>([]);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (key: string, p: Partial<ReceiveLineDraft>) => {
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...p } : l)));
  };
  const add = (h: Hit) => {
    setTitles((cur) => new Map(cur).set(h.variantId, h.title));
    setLines((cur) => [
      ...cur,
      {
        key: newId(),
        variantId: h.variantId,
        qty: "",
        cost: "",
        lot: "",
        expiresOn: "",
        salePrice: "",
      },
    ]);
  };

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (currency === "") {
      setError("The business currency is not set yet.");
      return;
    }
    const built = buildReceive(lines, currency, new Set());
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors(new Map());
    setBusy(true);
    setError(null);
    const payload = {
      locationId,
      currency,
      ...(reference.trim() === "" ? {} : { reference: reference.trim() }),
      lines: built.lines,
    };
    const receiptId = keyFor(JSON.stringify(payload));
    try {
      await api("POST", "/v1/inventory/receipts", {
        idempotencyKey: receiptId,
        body: { id: receiptId, ...payload },
      });
      await qc.invalidateQueries({ queryKey: stockKeys.all(t) });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Receiving failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="Receive stock" onClose={onClose}>
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
          help="Supplier invoice or delivery note number."
          onChange={(e) => {
            setReference(e.target.value);
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
                label="Quantity"
                inputMode="decimal"
                value={l.qty}
                error={errors.get(`${l.key}.qty`)}
                onChange={(e) => {
                  patch(l.key, { qty: e.target.value });
                }}
              />
              <TextField
                label={`Unit cost (${currency})`}
                inputMode="decimal"
                value={l.cost}
                error={errors.get(`${l.key}.cost`)}
                onChange={(e) => {
                  patch(l.key, { cost: e.target.value });
                }}
              />
              <TextField
                label="Lot code"
                value={l.lot}
                error={errors.get(`${l.key}.lot`)}
                onChange={(e) => {
                  patch(l.key, { lot: e.target.value });
                }}
              />
              <TextField
                label="Expires"
                type="date"
                value={l.expiresOn}
                error={errors.get(`${l.key}.expiresOn`)}
                onChange={(e) => {
                  patch(l.key, { expiresOn: e.target.value });
                }}
              />
              <TextField
                label={`Batch sale price (${currency})`}
                inputMode="decimal"
                value={l.salePrice}
                help="Optional. Wins over the price list for this batch."
                error={errors.get(`${l.key}.salePrice`)}
                onChange={(e) => {
                  patch(l.key, { salePrice: e.target.value });
                }}
              />
              <Button
                variant="ghost"
                onClick={() => {
                  setLines((cur) => cur.filter((x) => x.key !== l.key));
                }}
              >
                {`Remove ${title}`}
              </Button>
            </fieldset>
          );
        })}
        <Stack>
          <Row spread>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={busy} disabled={lines.length === 0}>
              Receive stock
            </Button>
          </Row>
        </Stack>
      </form>
    </Dialog>
  );
}
