"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorState,
  Row,
  SelectField,
  SkeletonRows,
  Stack,
  TextField,
  styles,
} from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import {
  bpsText,
  formatPrice,
  newId,
  parsePercent,
  parsePrice,
  priceText,
  pricingKeys,
  useFees,
} from "@/lib/pricing.ts";
import { useProfile } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./pricing.module.css";

import type { Fee } from "@/lib/pricing.ts";
import type { SubmitEvent } from "react";

export function FeesTab() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const fees = useFees(t);
  const currency = useProfile(t).data?.currency ?? "";
  const [editing, setEditing] = useState<Fee | "new" | null>(null);
  return (
    <Stack>
      <Row spread>
        <p className={styles.muted}>
          Fees are added to a sale: service charge, packaging, delivery. Each carries its own tax
          category.
        </p>
        <Button
          disabled={currency === ""}
          onClick={() => {
            setEditing("new");
          }}
        >
          New fee
        </Button>
      </Row>
      {fees.isPending ? <SkeletonRows label="Loading fees" rows={3} /> : null}
      {fees.isError ? (
        <ErrorState
          error={fees.error}
          onRetry={() => {
            void fees.refetch();
          }}
        />
      ) : null}
      {fees.data?.length === 0 ? <Empty title="No fees">Sales have no extra charges.</Empty> : null}
      {fees.data !== undefined && fees.data.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Fees</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Charge</th>
                <th scope="col">Tax category</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {fees.data.map((f) => (
                <tr key={f.id}>
                  <th scope="row">{f.name}</th>
                  <td className={s.num}>
                    {f.kind === "percent"
                      ? bpsText(f.value)
                      : currency === ""
                        ? String(f.value)
                        : formatPrice(f.value, currency)}
                  </td>
                  <td>{f.taxCategory}</td>
                  <td>{f.active ? <Badge>On</Badge> : <Badge tone="warning">Off</Badge>}</td>
                  <td>
                    <Button
                      variant="ghost"
                      disabled={currency === ""}
                      onClick={() => {
                        setEditing(f);
                      }}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editing === null || currency === "" ? null : (
        <FeeDialog
          key={editing === "new" ? "new" : editing.id}
          fee={editing === "new" ? null : editing}
          currency={currency}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </Stack>
  );
}

function FeeDialog({
  fee,
  currency,
  onClose,
}: {
  fee: Fee | null;
  currency: string;
  onClose: () => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const [name, setName] = useState(fee?.name ?? "");
  const [kind, setKind] = useState<Fee["kind"]>(fee?.kind ?? "percent");
  const [value, setValue] = useState(
    fee === null
      ? ""
      : fee.kind === "percent"
        ? String(fee.value / 100)
        : priceText(fee.value, currency),
  );
  const [category, setCategory] = useState(fee?.taxCategory ?? "standard");
  const [active, setActive] = useState(fee?.active ?? true);
  // One id per dialog: a retry after a lost response replays instead of creating a second fee.
  const [draftId] = useState(newId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | undefined>();

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const parsed = kind === "percent" ? parsePercent(value) : parsePrice(value, currency);
    if (typeof parsed === "string") {
      setValueError(parsed);
      return;
    }
    setValueError(undefined);
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), kind, value: parsed, taxCategory: category.trim(), active };
      if (fee === null) await api("POST", "/v1/pricing/fees", { body: { id: draftId, ...body } });
      else
        await api("PATCH", `/v1/pricing/fees/${fee.id}`, {
          body: { version: fee.version, ...body },
        });
      await qc.invalidateQueries({ queryKey: pricingKeys.fees(t) });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "Someone else changed this fee. Close and reopen it."
          : err instanceof Error
            ? err.message
            : "Saving failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title={fee === null ? "New fee" : "Edit fee"} onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <TextField
          label="Name"
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <div className={s.grid}>
          <SelectField
            label="Type"
            value={kind}
            options={[
              { value: "percent", label: "Percentage of the sale" },
              { value: "amount", label: `Fixed amount (${currency})` },
            ]}
            onChange={(e) => {
              setKind(e.target.value as Fee["kind"]);
              setValueError(undefined);
            }}
          />
          <TextField
            label={kind === "percent" ? "Percentage" : "Amount"}
            required
            inputMode="decimal"
            value={value}
            error={valueError}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </div>
        <TextField
          label="Tax category"
          required
          value={category}
          help="The tax rules that apply to this fee, like standard or exempt."
          onChange={(e) => {
            setCategory(e.target.value);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => {
              setActive(e.target.checked);
            }}
          />{" "}
          Charge this fee on new sales
        </label>
        <Row spread>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Save
          </Button>
        </Row>
      </form>
    </Dialog>
  );
}
