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
import { bpsText, newId, parsePercent, pricingKeys, useTaxRegions } from "@/lib/pricing.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./pricing.module.css";

import type { TaxRegion } from "@/lib/pricing.ts";
import type { SubmitEvent } from "react";

interface RuleDraft {
  readonly id: string;
  readonly name: string;
  readonly rate: string;
  readonly categories: string;
  readonly compound: boolean;
}

const blankRule = (): RuleDraft => ({
  id: newId(),
  name: "",
  rate: "",
  categories: "*",
  compound: false,
});

export function TaxTab() {
  const { tenant } = useTenant();
  const regions = useTaxRegions(tenant.tenantId);
  const [editing, setEditing] = useState<TaxRegion | "new" | null>(null);
  return (
    <Stack>
      <Row spread>
        <p className={styles.muted}>
          A tax region says which taxes apply, at what rate, and whether shelf prices already
          include tax.
        </p>
        <Button
          onClick={() => {
            setEditing("new");
          }}
        >
          New tax region
        </Button>
      </Row>
      {regions.isPending ? <SkeletonRows label="Loading tax regions" rows={3} /> : null}
      {regions.isError ? (
        <ErrorState
          error={regions.error}
          onRetry={() => {
            void regions.refetch();
          }}
        />
      ) : null}
      {regions.data?.length === 0 ? (
        <Empty title="No tax regions">Add one before you create a price list.</Empty>
      ) : null}
      {regions.data !== undefined && regions.data.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Tax regions</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Prices</th>
                <th scope="col">Taxes</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {regions.data.map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    {r.name} <Badge>{r.code}</Badge>
                  </th>
                  <td>{r.inclusive ? "Include tax" : "Exclude tax"}</td>
                  <td>
                    {r.rules.length === 0
                      ? "None"
                      : r.rules.map((x) => `${x.name} ${bpsText(x.rateBps)}`).join(", ")}
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditing(r);
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
      {editing === null ? null : (
        <RegionDialog
          key={editing === "new" ? "new" : editing.id}
          region={editing === "new" ? null : editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </Stack>
  );
}

function RegionDialog({ region, onClose }: { region: TaxRegion | null; onClose: () => void }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const [code, setCode] = useState(region?.code ?? "");
  const [name, setName] = useState(region?.name ?? "");
  const [inclusive, setInclusive] = useState(region?.inclusive ?? false);
  const [strategy, setStrategy] = useState<TaxRegion["strategy"]>(region?.strategy ?? "per-line");
  const [rounding, setRounding] = useState<TaxRegion["roundingMode"]>(
    region?.roundingMode ?? "half-even",
  );
  const [rules, setRules] = useState<RuleDraft[]>(
    region?.rules.map((r) => ({
      id: r.id,
      name: r.name,
      rate: String(r.rateBps / 100),
      categories: r.categories.join(", "),
      compound: r.compound,
    })) ?? [blankRule()],
  );
  const [draftId] = useState(newId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ruleErrors, setRuleErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const patchRule = (id: string, patch: Partial<RuleDraft>) => {
    setRules((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const errs = new Map<string, string>();
    const parsed = rules.map((r, order) => {
      const bps = parsePercent(r.rate);
      if (typeof bps === "string") errs.set(r.id, bps);
      else if (r.name.trim() === "") errs.set(r.id, "Name the tax.");
      return {
        id: r.id,
        name: r.name.trim(),
        rateBps: typeof bps === "number" ? bps : 0,
        compound: r.compound,
        categories: r.categories
          .split(",")
          .map((c) => c.trim().toLowerCase())
          .filter((c) => c !== ""),
        order,
      };
    });
    setRuleErrors(errs);
    if (errs.size > 0) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        inclusive,
        strategy,
        roundingMode: rounding,
        rules: parsed,
      };
      if (region === null)
        await api("POST", "/v1/pricing/tax-regions", {
          body: { id: draftId, code: code.trim().toLowerCase(), ...body },
        });
      else
        await api("PUT", `/v1/pricing/tax-regions/${region.id}`, {
          body: { version: region.version, ...body },
        });
      await qc.invalidateQueries({ queryKey: pricingKeys.regions(t) });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "Someone else changed this region. Close and reopen it."
          : err instanceof Error
            ? err.message
            : "Saving failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title={region === null ? "New tax region" : "Edit tax region"} onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <div className={s.grid}>
          <TextField
            label="Name"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          {region === null ? (
            <TextField
              label="Code"
              required
              value={code}
              help="Lowercase, like lk or eu-vat. Cannot change later."
              onChange={(e) => {
                setCode(e.target.value);
              }}
            />
          ) : null}
        </div>
        <div className={s.grid}>
          <SelectField
            label="Shelf prices"
            value={inclusive ? "in" : "ex"}
            options={[
              { value: "ex", label: "Exclude tax (added at the till)" },
              { value: "in", label: "Include tax" },
            ]}
            onChange={(e) => {
              setInclusive(e.target.value === "in");
            }}
          />
          <SelectField
            label="Tax is worked out"
            value={strategy}
            options={[
              { value: "per-line", label: "On each line" },
              { value: "per-document", label: "On the whole receipt" },
            ]}
            onChange={(e) => {
              setStrategy(e.target.value as TaxRegion["strategy"]);
            }}
          />
          <SelectField
            label="Rounding"
            value={rounding}
            options={[
              { value: "half-even", label: "Half to even" },
              { value: "half-up", label: "Half up" },
              { value: "up", label: "Always up" },
              { value: "down", label: "Always down" },
            ]}
            onChange={(e) => {
              setRounding(e.target.value as TaxRegion["roundingMode"]);
            }}
          />
        </div>
        <h3>Taxes</h3>
        {rules.map((r, i) => (
          <fieldset key={r.id} className={s.grid}>
            <legend>{`Tax ${String(i + 1)}`}</legend>
            <TextField
              label="Name"
              value={r.name}
              error={ruleErrors.get(r.id)}
              onChange={(e) => {
                patchRule(r.id, { name: e.target.value });
              }}
            />
            <TextField
              label="Rate (%)"
              inputMode="decimal"
              value={r.rate}
              onChange={(e) => {
                patchRule(r.id, { rate: e.target.value });
              }}
            />
            <TextField
              label="Tax categories"
              value={r.categories}
              help="Comma list, or * for everything."
              onChange={(e) => {
                patchRule(r.id, { categories: e.target.value });
              }}
            />
            <label>
              <input
                type="checkbox"
                checked={r.compound}
                onChange={(e) => {
                  patchRule(r.id, { compound: e.target.checked });
                }}
              />{" "}
              Charged on top of earlier taxes
            </label>
            <Button
              variant="ghost"
              onClick={() => {
                setRules((cur) => cur.filter((x) => x.id !== r.id));
              }}
            >
              Remove tax
            </Button>
          </fieldset>
        ))}
        <Row>
          <Button
            variant="secondary"
            onClick={() => {
              setRules((cur) => [...cur, blankRule()]);
            }}
          >
            Add a tax
          </Button>
        </Row>
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
