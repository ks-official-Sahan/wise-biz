"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { describePromotion, newId, pricingKeys, usePromotions } from "@/lib/pricing.ts";
import { useProfile } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./pricing.module.css";

import type { Promotion } from "@/lib/pricing.ts";
import type { SubmitEvent } from "react";

type Filter = "all" | Promotion["status"];

const TONE = { draft: "neutral", published: "accent", archived: "warning" } as const;

export function PromotionsTab() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [status, setStatus] = useState<Filter>("all");
  const promos = usePromotions(t, status);
  const currency = useProfile(t).data?.currency;
  const [creating, setCreating] = useState(false);
  const rows = promos.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Stack>
      <Row spread>
        <p className={styles.muted}>
          Promotions start as drafts. Publishing makes them live at every till after the next sync.
        </p>
        <Button
          onClick={() => {
            setCreating(true);
          }}
        >
          New promotion
        </Button>
      </Row>
      <SelectField
        label="Show"
        value={status}
        options={[
          { value: "all", label: "All promotions" },
          { value: "draft", label: "Drafts" },
          { value: "published", label: "Published" },
          { value: "archived", label: "Archived" },
        ]}
        onChange={(e) => {
          setStatus(e.target.value as Filter);
        }}
      />
      {promos.isPending ? <SkeletonRows label="Loading promotions" /> : null}
      {promos.isError ? (
        <ErrorState
          error={promos.error}
          onRetry={() => {
            void promos.refetch();
          }}
        />
      ) : null}
      {promos.isSuccess && rows.length === 0 ? (
        <Empty title="No promotions">Create one to run a discount.</Empty>
      ) : null}
      {rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Promotions</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">What it does</th>
                <th scope="col">Runs</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <th scope="row">
                    <Link href={`/pricing/promotions/${p.id}`}>{p.name}</Link>
                    {p.requiresCoupon ? <> · coupon</> : null}
                  </th>
                  <td>{currency == null ? "" : describePromotion(p, currency)}</td>
                  <td>
                    {p.startsAt === null && p.endsAt === null
                      ? "Always"
                      : `${p.startsAt === null ? "" : new Date(p.startsAt).toLocaleDateString()} – ${p.endsAt === null ? "" : new Date(p.endsAt).toLocaleDateString()}`}
                  </td>
                  <td>
                    <Badge tone={TONE[p.status]}>{p.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {promos.hasNextPage ? (
        <Button
          variant="secondary"
          busy={promos.isFetchingNextPage}
          onClick={() => {
            void promos.fetchNextPage();
          }}
        >
          Load more
        </Button>
      ) : null}
      {creating ? (
        <CreateDialog
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}
    </Stack>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState("");
  const [id] = useState(newId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/v1/pricing/promotions", {
        body: {
          id,
          name: name.trim(),
          target: { kind: "cart" },
          effect: { kind: "percent", bps: 1000 },
        },
      });
      await qc.invalidateQueries({ queryKey: pricingKeys.all(t) });
      router.push(`/pricing/promotions/${id}`);
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error ? err.message : "Saving failed. Try again.",
      );
      setBusy(false);
    }
  }

  return (
    <Dialog open title="New promotion" onClose={onClose}>
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
          help="Customers see this on the receipt, like Weekend 10% off."
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <Row spread>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Create draft
          </Button>
        </Row>
      </form>
    </Dialog>
  );
}
