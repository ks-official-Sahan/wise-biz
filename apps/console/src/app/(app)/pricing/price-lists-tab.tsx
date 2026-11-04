"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
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
import { newId, pricingKeys, usePriceLists, useTaxRegions } from "@/lib/pricing.ts";
import { useProfile } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./pricing.module.css";

import type { SubmitEvent } from "react";

export function PriceListsTab() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const lists = usePriceLists(t);
  const regions = useTaxRegions(t);
  const [creating, setCreating] = useState(false);
  const regionName = new Map((regions.data ?? []).map((r) => [r.id, r.name]));

  return (
    <Stack>
      <Row spread>
        <p className={styles.muted}>
          A price list holds the selling price of each variant. The till uses the list of its
          branch.
        </p>
        <Button
          onClick={() => {
            setCreating(true);
          }}
        >
          New price list
        </Button>
      </Row>
      {lists.isPending ? <SkeletonRows label="Loading price lists" /> : null}
      {lists.isError ? (
        <ErrorState
          error={lists.error}
          onRetry={() => {
            void lists.refetch();
          }}
        />
      ) : null}
      {lists.data?.length === 0 ? (
        <Empty title="No price lists yet">Create one to price your products.</Empty>
      ) : null}
      {lists.data !== undefined && lists.data.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Price lists</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Currency</th>
                <th scope="col">Tax region</th>
                <th scope="col">Valid</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {lists.data.map((l) => (
                <tr key={l.id}>
                  <th scope="row">
                    <Link href={`/pricing/lists/${l.id}`}>{l.name}</Link>
                    {l.customerGroup === null ? null : <> · {l.customerGroup}</>}
                  </th>
                  <td>{l.currency}</td>
                  <td>{regionName.get(l.taxRegionId) ?? "…"}</td>
                  <td>
                    {l.validFrom === null && l.validTo === null
                      ? "Always"
                      : `${l.validFrom === null ? "" : new Date(l.validFrom).toLocaleDateString()} – ${l.validTo === null ? "" : new Date(l.validTo).toLocaleDateString()}`}
                  </td>
                  <td>
                    {l.archived ? <Badge tone="warning">Archived</Badge> : <Badge>Active</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <CreateListDialog
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
      />
    </Stack>
  );
}

function CreateListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const regions = useTaxRegions(t);
  const [name, setName] = useState("");
  const profile = useProfile(t);
  const [typedCurrency, setCurrency] = useState<string | null>(null);
  const currency = typedCurrency ?? profile.data?.currency ?? "";
  const [regionId, setRegionId] = useState("");
  const [group, setGroup] = useState("");
  const [draftId, setDraftId] = useState(newId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | string | null>(null);
  const field = (path: string): string | undefined =>
    error instanceof ApiError ? error.fieldError(path) : undefined;

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const taxRegionId = regionId === "" ? regions.data?.[0]?.id : regionId;
    if (taxRegionId === undefined) {
      setError("Add a tax region first (Tax regions tab).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/v1/pricing/price-lists", {
        body: {
          id: draftId,
          name: name.trim(),
          currency: currency.trim().toUpperCase(),
          taxRegionId,
          ...(group.trim() === "" ? {} : { customerGroup: group.trim() }),
        },
      });
      await qc.invalidateQueries({ queryKey: pricingKeys.lists(t) });
      setName("");
      setDraftId(newId());
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : "Saving failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title="New price list" onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {error === null ? null : (
          <Alert tone="danger">{error instanceof ApiError ? error.message : error}</Alert>
        )}
        <TextField
          label="Name"
          required
          value={name}
          error={field("name")}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <div className={s.grid}>
          <TextField
            label="Currency"
            required
            maxLength={3}
            value={currency}
            help="ISO code, like LKR or USD."
            error={field("currency")}
            onChange={(e) => {
              setCurrency(e.target.value);
            }}
          />
          <SelectField
            label="Tax region"
            value={regionId}
            options={(regions.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
            onChange={(e) => {
              setRegionId(e.target.value);
            }}
          />
        </div>
        <TextField
          label="Customer group (optional)"
          value={group}
          help="Only customers in this group get this list."
          onChange={(e) => {
            setGroup(e.target.value);
          }}
        />
        <Row spread>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Create
          </Button>
        </Row>
      </form>
    </Dialog>
  );
}
