"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Alert, Button, Dialog, Row, Stack, TextField } from "@/components/ui.tsx";
import { api } from "@/lib/api.ts";
import {
  actionErrorText,
  buildLineQty,
  procurementKeys,
  receiveHint,
  useAttemptKey,
} from "@/lib/procurement.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../../purchasing/procurement.module.css";

import type { Transfer } from "@/lib/procurement.ts";
import type { SubmitEvent } from "react";

/** Quantities per line, defaulting to what was requested. Dispatch covers every line; each needs a quantity above zero. */
export function DispatchDialog({
  transfer,
  titles,
  onClose,
}: {
  readonly transfer: Transfer;
  readonly titles: ReadonlyMap<string, string>;
  readonly onClose: () => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const keyFor = useAttemptKey();
  const [values, setValues] = useState<ReadonlyMap<number, string>>(
    () => new Map(transfer.lines.map((l) => [l.line, l.requestedQty] as const)),
  );
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const built = buildLineQty(
      transfer.lines.map((l) => ({ line: l.line, value: values.get(l.line) ?? "" })),
      { allowZero: false, skipBlank: false },
    );
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors(new Map());
    setBusy(true);
    setError(null);
    const body = { version: transfer.version, lines: built.body };
    try {
      await api("POST", `/v1/procurement/transfers/${encodeURIComponent(transfer.id)}/dispatch`, {
        body,
        idempotencyKey: keyFor(`dispatch|${transfer.id}|${JSON.stringify(body)}`),
      });
      await qc.invalidateQueries({ queryKey: procurementKeys.all(t) });
      onClose();
    } catch (err) {
      setError(actionErrorText(err, "Could not dispatch the transfer. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title={`Dispatch transfer ${String(transfer.transferNo)}`} onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <Stack>
          {error === null ? null : <Alert tone="danger">{error}</Alert>}
          <p>Stock leaves the source now and is in transit until it is received.</p>
          {transfer.lines.map((l) => (
            <fieldset key={l.line} className={s.line}>
              <legend>{titles.get(l.variantId) ?? "Product"}</legend>
              <TextField
                label="Quantity to dispatch"
                inputMode="decimal"
                value={values.get(l.line) ?? ""}
                help={`Requested ${l.requestedQty}`}
                error={errors.get(`line-${String(l.line)}`)}
                onChange={(e) => {
                  const next = e.target.value;
                  setValues((cur) => new Map(cur).set(l.line, next));
                }}
              />
            </fieldset>
          ))}
          {errors.get("lines") === undefined ? null : (
            <Alert tone="danger">{errors.get("lines")}</Alert>
          )}
          <Row spread>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={busy}>
              Dispatch stock
            </Button>
          </Row>
        </Stack>
      </form>
    </Dialog>
  );
}

/** Received per line, defaulting to what was dispatched. Zero is allowed (nothing arrived). A shortage is shown in words. */
export function ReceiveTransferDialog({
  transfer,
  titles,
  onClose,
}: {
  readonly transfer: Transfer;
  readonly titles: ReadonlyMap<string, string>;
  readonly onClose: () => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const keyFor = useAttemptKey();
  const [values, setValues] = useState<ReadonlyMap<number, string>>(
    () => new Map(transfer.lines.map((l) => [l.line, l.dispatchedQty] as const)),
  );
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const built = buildLineQty(
      transfer.lines.map((l) => ({ line: l.line, value: values.get(l.line) ?? "" })),
      { allowZero: true, skipBlank: false },
    );
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors(new Map());
    setBusy(true);
    setError(null);
    const body = {
      version: transfer.version,
      lines: built.body.map((l) => ({ line: l.line, receivedQty: l.qty })),
    };
    try {
      await api("POST", `/v1/procurement/transfers/${encodeURIComponent(transfer.id)}/receive`, {
        body,
        idempotencyKey: keyFor(`receive|${transfer.id}|${JSON.stringify(body)}`),
      });
      await qc.invalidateQueries({ queryKey: procurementKeys.all(t) });
      onClose();
    } catch (err) {
      setError(actionErrorText(err, "Could not receive the transfer. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title={`Receive transfer ${String(transfer.transferNo)}`} onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <Stack>
          {error === null ? null : <Alert tone="danger">{error}</Alert>}
          <p>Stock lands at the destination. Any shortage is written off as a loss.</p>
          {transfer.lines.map((l) => {
            const value = values.get(l.line) ?? "";
            const hint = receiveHint(l.dispatchedQty, value);
            return (
              <fieldset key={l.line} className={s.line}>
                <legend>{titles.get(l.variantId) ?? "Product"}</legend>
                <TextField
                  label="Quantity received"
                  inputMode="decimal"
                  value={value}
                  help={`Dispatched ${l.dispatchedQty}${hint === null ? "" : `. ${hint}`}`}
                  error={errors.get(`line-${String(l.line)}`)}
                  onChange={(e) => {
                    const next = e.target.value;
                    setValues((cur) => new Map(cur).set(l.line, next));
                  }}
                />
              </fieldset>
            );
          })}
          {errors.get("lines") === undefined ? null : (
            <Alert tone="danger">{errors.get("lines")}</Alert>
          )}
          <Row spread>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={busy}>
              Record receipt
            </Button>
          </Row>
        </Stack>
      </form>
    </Dialog>
  );
}
