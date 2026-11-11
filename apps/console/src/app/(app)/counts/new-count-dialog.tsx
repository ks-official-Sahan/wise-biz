"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Alert, Button, Dialog, Row, SelectField, Stack, TextField } from "@/components/ui.tsx";
import { VariantPicker } from "@/components/variant-picker.tsx";
import { api } from "@/lib/api.ts";
import { useCommand } from "@/lib/command.ts";
import { buildCount, countKeys } from "@/lib/counts.ts";
import { useAllLocations } from "@/lib/procurement.ts";
import { useBranches, useProfile } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import inv from "../inventory.module.css";
import s from "../purchasing/procurement.module.css";

import type { Hit } from "@/components/variant-picker.tsx";
import type { Count, CountKind, CountMode } from "@/lib/counts.ts";

/** Start a count at one location. Nothing changes in stock until the count is approved. */
export function NewCountDialog({ onClose }: { readonly onClose: () => void }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const router = useRouter();
  const branches = useBranches(t);
  const profile = useProfile(t);
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

  const [locationId, setLocationId] = useState("");
  const [kind, setKind] = useState<CountKind>("full");
  const [mode, setMode] = useState<CountMode>("frozen");
  const [blind, setBlind] = useState(false);
  const [currency, setCurrency] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [variants, setVariants] = useState<readonly { id: string; title: string }[]>([]);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const shownCurrency = currency ?? profile.data?.currency ?? "";

  const cmd = useCommand<null>(async (_, key) => {
    const built = buildCount({
      locationId,
      kind,
      variantIds: variants.map((v) => v.id),
      blind,
      mode,
      currency: shownCurrency,
      note,
    });
    if (!built.ok) {
      setErrors(built.errors);
      throw new Error("Check the highlighted fields.");
    }
    setErrors(new Map());
    const created = await api<Count>("POST", "/v1/inventory/counts", {
      body: built.body,
      idempotencyKey: key,
    });
    await qc.invalidateQueries({ queryKey: countKeys.all(t) });
    onClose();
    router.push(`/counts/${created.id}`);
  });

  const add = (h: Hit) => {
    setVariants((cur) =>
      cur.some((v) => v.id === h.variantId) ? cur : [...cur, { id: h.variantId, title: h.title }],
    );
  };

  return (
    <Dialog open title="New stock count" onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          void cmd.submit(null);
        }}
      >
        {cmd.error === null ? null : <Alert tone="danger">{cmd.error}</Alert>}
        <SelectField
          label="Location"
          value={locationId}
          error={errors.get("locationId")}
          options={[{ value: "", label: "Pick a location" }, ...options]}
          onChange={(e) => {
            setLocationId(e.target.value);
          }}
        />
        <div className={s.grid}>
          <SelectField
            label="Count"
            value={kind}
            help={
              kind === "full"
                ? "Every product at this location."
                : "Only the products you add below."
            }
            options={[
              { value: "full", label: "Full count" },
              { value: "cycle", label: "Cycle count" },
            ]}
            onChange={(e) => {
              setKind(e.target.value as CountKind);
            }}
          />
          <SelectField
            label="Mode"
            value={mode}
            help={
              mode === "frozen"
                ? "Stock is recorded at the start. Approval refuses if stock moved."
                : "Sales during the count are allowed. Variance counts the movements."
            }
            options={[
              { value: "frozen", label: "Frozen (snapshot)" },
              { value: "live", label: "Live (sales continue)" },
            ]}
            onChange={(e) => {
              setMode(e.target.value as CountMode);
            }}
          />
        </div>
        <label className={inv.check}>
          <input
            type="checkbox"
            checked={blind}
            aria-describedby="blind-help"
            onChange={(e) => {
              setBlind(e.target.checked);
            }}
          />
          <span>Blind count</span>
        </label>
        <p id="blind-help" className={inv.help}>
          Counters do not see the expected quantities until the count is in review.
        </p>
        <TextField
          label="Currency"
          value={shownCurrency}
          error={errors.get("currency")}
          maxLength={3}
          autoCapitalize="characters"
          onChange={(e) => {
            setCurrency(e.target.value.toUpperCase());
          }}
        />
        {kind === "cycle" ? (
          <Stack>
            <VariantPicker label="Add a product to count" onPick={add} />
            {variants.length === 0 ? (
              <p className={inv.help}>No products added yet.</p>
            ) : (
              <ul className={inv.list} aria-label="Products in this count">
                {variants.map((v) => (
                  <li key={v.id} className={inv.item}>
                    <Row spread>
                      <span>{v.title}</span>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setVariants((cur) => cur.filter((x) => x.id !== v.id));
                        }}
                      >
                        {`Remove ${v.title}`}
                      </Button>
                    </Row>
                  </li>
                ))}
              </ul>
            )}
          </Stack>
        ) : null}
        {errors.get("scope") === undefined ? null : (
          <p role="alert" className={inv.help}>
            {errors.get("scope")}
          </p>
        )}
        <TextField
          label="Note (optional)"
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
        <Row spread>
          <Button variant="ghost" disabled={cmd.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={cmd.busy} disabled={locationId === ""}>
            Start count
          </Button>
        </Row>
      </form>
    </Dialog>
  );
}
