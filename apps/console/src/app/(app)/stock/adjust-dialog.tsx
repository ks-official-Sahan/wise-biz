"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { Alert, Button, Dialog, Row, SelectField, TextField } from "@/components/ui.tsx";
import { VariantPicker } from "@/components/variant-picker.tsx";
import { ApiError, api } from "@/lib/api.ts";
import { ADJUST_REASONS, buildAdjust, stockKeys } from "@/lib/inventory.ts";
import { newId } from "@/lib/pricing.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./stock.module.css";

import type { Hit } from "@/components/variant-picker.tsx";
import type { AdjustLineDraft, AdjustReason } from "@/lib/inventory.ts";
import type { SubmitEvent } from "react";

export function AdjustDialog({ locationId, onClose }: { locationId: string; onClose: () => void }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  // The key follows the payload: a retry of the same body replays, a changed body is a new request.
  const attempt = useRef<{ id: string; sig: string } | null>(null);
  const keyFor = (sig: string): string => {
    if (attempt.current?.sig !== sig) attempt.current = { id: newId(), sig };
    return attempt.current.id;
  };
  const [reason, setReason] = useState<AdjustReason>("count_correction");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<readonly AdjustLineDraft[]>([]);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = (h: Hit) => {
    setTitles((cur) => new Map(cur).set(h.variantId, h.title));
    setLines((cur) => [...cur, { key: newId(), variantId: h.variantId, batchId: null, qty: "" }]);
  };

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const built = buildAdjust(lines, reason, note);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors(new Map());
    setBusy(true);
    setError(null);
    const payload = {
      locationId,
      reason,
      ...(note.trim() === "" ? {} : { note: note.trim() }),
      lines: built.lines,
    };
    const adjustmentId = keyFor(JSON.stringify(payload));
    try {
      await api("POST", "/v1/inventory/adjustments", {
        idempotencyKey: adjustmentId,
        body: { id: adjustmentId, ...payload },
      });
      await qc.invalidateQueries({ queryKey: stockKeys.all(t) });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 412
          ? `This adjustment is worth more than your role may approve alone. ${err.message}`
          : err instanceof Error
            ? err.message
            : "Adjusting failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="Adjust stock" onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <div className={s.grid}>
          <SelectField
            label="Reason"
            value={reason}
            options={ADJUST_REASONS}
            onChange={(e) => {
              setReason(e.target.value as AdjustReason);
            }}
          />
          <TextField
            label={reason === "other" ? "What happened" : "Note (optional)"}
            value={note}
            error={errors.get("note")}
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
        </div>
        <VariantPicker label="Add a product" onPick={add} />
        {errors.get("lines") === undefined ? null : <p role="alert">{errors.get("lines")}</p>}
        {lines.map((l) => {
          const title = titles.get(l.variantId) ?? "Product";
          return (
            <fieldset key={l.key} className={s.line}>
              <legend>{title}</legend>
              <TextField
                label="Change in quantity"
                inputMode="decimal"
                value={l.qty}
                help="Use a minus sign to remove stock, like -3."
                error={errors.get(`${l.key}.qty`)}
                onChange={(e) => {
                  setLines((cur) =>
                    cur.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)),
                  );
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
        <Row spread>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={lines.length === 0}>
            Save adjustment
          </Button>
        </Row>
      </form>
    </Dialog>
  );
}
