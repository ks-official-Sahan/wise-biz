"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { ConfirmAction } from "@/components/confirm-action.tsx";
import {
  Alert,
  Badge,
  Button,
  Empty,
  ErrorState,
  SelectField,
  SkeletonRows,
  Stack,
  TextField,
  styles,
} from "@/components/ui.tsx";
import { api, isNotFound } from "@/lib/api.ts";
import { useCommand } from "@/lib/command.ts";
import {
  EXPIRY_DAY_OPTIONS,
  buildWriteOff,
  daysLeftText,
  defaultFefoRange,
  expiryKeys,
  fefoRangeError,
  fefoText,
  markdownEvidenceText,
  markdownText,
  useFefo,
  useNearExpiry,
  writeOffEligible,
  WRITE_OFF_HORIZON_DAYS,
} from "@/lib/expiry.ts";
import { formatPrice, useVariantNames } from "@/lib/pricing.ts";
import { useReturnFocus, useAllLocations } from "@/lib/procurement.ts";
import { useBranches } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import inv from "../inventory.module.css";
import p from "../purchasing/procurement.module.css";

import type { MarkdownSuggestion, NearExpiryItem, WriteOffResult } from "@/lib/expiry.ts";

type Tab = "near" | "fefo";

export default function ExpiryPage() {
  const [tab, setTab] = useState<Tab>("near");
  return (
    <Stack>
      <h1>Expiry</h1>
      <div className={p.tabs} role="tablist" aria-label="Expiry views">
        <button
          type="button"
          role="tab"
          id="tab-near"
          className={p.tab}
          aria-selected={tab === "near"}
          aria-controls="panel-near"
          tabIndex={tab === "near" ? 0 : -1}
          onClick={() => {
            setTab("near");
          }}
        >
          Near expiry
        </button>
        <button
          type="button"
          role="tab"
          id="tab-fefo"
          className={p.tab}
          aria-selected={tab === "fefo"}
          aria-controls="panel-fefo"
          tabIndex={tab === "fefo" ? 0 : -1}
          onClick={() => {
            setTab("fefo");
          }}
        >
          FEFO report
        </button>
      </div>
      {tab === "near" ? <NearExpiryPanel /> : <FefoPanel />}
    </Stack>
  );
}

/** Location names for the expiry screens, one list for every branch. */
function useLocationLabels() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const branches = useBranches(t);
  const branchIds = useMemo(
    () => (branches.data ?? []).filter((b) => !b.archived).map((b) => b.branchId),
    [branches.data],
  );
  const locations = useAllLocations(t, branchIds);
  const label = useMemo(() => {
    const branchName = new Map((branches.data ?? []).map((b) => [b.branchId, b.name] as const));
    return new Map(
      locations.map(
        (l) => [l.locationId, `${branchName.get(l.branchId) ?? ""} · ${l.name}`] as const,
      ),
    );
  }, [branches.data, locations]);
  return { locations, label };
}

interface Picked {
  readonly row: NearExpiryItem;
  readonly qty: string;
}

function NearExpiryPanel() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const focus = useReturnFocus();
  const [days, setDays] = useState<number>(30);
  const [locationId, setLocationId] = useState("");
  const [picked, setPicked] = useState<ReadonlyMap<string, Picked>>(new Map());
  const [note, setNote] = useState("");
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [done, setDone] = useState<WriteOffResult | null>(null);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const near = useNearExpiry(t, days, locationId);
  const rows = useMemo(() => near.data?.pages.flatMap((pg) => pg.items) ?? [], [near.data]);
  const names = useVariantNames(t, [...new Set(rows.map((r) => r.variantId))]);
  const { locations, label } = useLocationLabels();
  const selectedLocation = [...picked.values()][0]?.row.locationId ?? null;
  const title = (variantId: string): string => {
    const v = names.get(variantId);
    return v === undefined ? "Product" : `${v.productName} · ${v.name}`;
  };

  const doWriteOff = async (key: string): Promise<void> => {
    const built = buildWriteOff(
      [...picked.values()].map((x) => ({
        batchId: x.row.batchId,
        variantId: x.row.variantId,
        locationId: x.row.locationId,
        qtyOnHand: x.row.qtyOnHand,
        daysLeft: x.row.daysLeft,
        qty: x.qty,
      })),
      note,
    );
    if (!built.ok) {
      setErrors(built.errors);
      throw new Error("Check the highlighted quantities.");
    }
    setErrors(new Map());
    const result = await api<WriteOffResult>("POST", "/v1/inventory/expiry/writeoffs", {
      body: built.body,
      idempotencyKey: key,
    });
    await qc.invalidateQueries({ queryKey: expiryKeys.all(t) });
    await qc.invalidateQueries({ queryKey: [t, "stock"] });
    setPicked(new Map());
    setNote("");
    setDone(result);
  };

  const toggle = (row: NearExpiryItem, on: boolean) => {
    setPicked((cur) => {
      const next = new Map(cur);
      if (on) next.set(row.batchId, { row, qty: row.qtyOnHand });
      else next.delete(row.batchId);
      return next;
    });
  };

  return (
    <div role="tabpanel" id="panel-near" aria-labelledby="tab-near">
      <Stack>
        <div className={p.grid}>
          <SelectField
            label="Expires within"
            value={String(days)}
            options={EXPIRY_DAY_OPTIONS.map((d) => ({
              value: String(d),
              label: `${String(d)} days`,
            }))}
            onChange={(e) => {
              setDays(Number(e.target.value));
            }}
          />
          <SelectField
            label="Location"
            value={locationId}
            options={[
              { value: "", label: "All locations" },
              ...locations
                .filter((l) => !l.archived)
                .map((l) => ({ value: l.locationId, label: label.get(l.locationId) ?? l.name }))
                .sort((a, b) => a.label.localeCompare(b.label)),
            ]}
            onChange={(e) => {
              setLocationId(e.target.value);
              setPicked(new Map());
            }}
          />
        </div>

        {done === null ? null : (
          <Alert tone="success">
            {`Wrote off ${formatPrice(done.valueMinor, done.currency)} of stock across ${String(done.lines.length)} ${done.lines.length === 1 ? "batch" : "batches"}.`}
          </Alert>
        )}

        {picked.size === 0 ? null : (
          <div className={inv.bar} role="region" aria-label="Batches picked for write-off">
            <p className={inv.reason}>
              {`${String(picked.size)} ${picked.size === 1 ? "batch" : "batches"} picked for write-off at ${label.get(selectedLocation ?? "") ?? "one location"}.`}
            </p>
            <div className={inv.rowActions}>
              <Button
                variant="ghost"
                onClick={() => {
                  setPicked(new Map());
                }}
              >
                Clear picked batches
              </Button>
              <Button
                variant="danger"
                onClick={(e) => {
                  focus.remember(e.currentTarget);
                  setErrors(new Map());
                  setWriteOffOpen(true);
                }}
              >
                Write off picked batches
              </Button>
            </div>
          </div>
        )}

        {near.isPending ? <SkeletonRows label="Loading batches near expiry" /> : null}
        {near.isError ? (
          isNotFound(near.error) ? (
            <Empty title="Expiry is not open to your role">
              Ask an owner to grant expiry access.
            </Empty>
          ) : (
            <ErrorState
              error={near.error}
              onRetry={() => {
                void near.refetch();
              }}
            />
          )
        ) : null}
        {near.isSuccess && rows.length === 0 ? (
          <Empty title={`Nothing expires in ${String(days)} days`}>
            Batches with stock left appear here as their date comes closer. Expired stock is
            included.
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">Batches that expire soon, soonest first</caption>
              <thead>
                <tr>
                  <th scope="col">Write off</th>
                  <th scope="col">Product</th>
                  <th scope="col">Location</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Time left</th>
                  <th scope="col" className={inv.num}>
                    On hand
                  </th>
                  <th scope="col" className={inv.num}>
                    Value
                  </th>
                  <th scope="col">Markdown</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const eligible = writeOffEligible(r.daysLeft);
                  const otherLocation =
                    selectedLocation !== null && selectedLocation !== r.locationId;
                  const disabled = !eligible || otherLocation;
                  const reason = !eligible
                    ? `Write-off is for stock expiring within ${String(WRITE_OFF_HORIZON_DAYS)} days`
                    : otherLocation
                      ? "Picked batches must be at one location"
                      : "";
                  return (
                    <tr key={r.batchId}>
                      <td>
                        <label className={inv.check}>
                          <input
                            type="checkbox"
                            checked={picked.has(r.batchId)}
                            disabled={disabled && !picked.has(r.batchId)}
                            aria-label={`Write off ${title(r.variantId)}, ${r.lotCode ?? r.batchId}`}
                            aria-describedby={reason === "" ? undefined : `why-${r.batchId}`}
                            onChange={(e) => {
                              toggle(r, e.target.checked);
                            }}
                          />
                        </label>
                        {reason === "" ? null : (
                          <div id={`why-${r.batchId}`} className={inv.help}>
                            {reason}
                          </div>
                        )}
                      </td>
                      <th scope="row">{title(r.variantId)}</th>
                      <td>{label.get(r.locationId) ?? "…"}</td>
                      <td className={inv.nowrap}>{r.expiresOn}</td>
                      <td>
                        <Badge tone={r.daysLeft <= WRITE_OFF_HORIZON_DAYS ? "warning" : "neutral"}>
                          {daysLeftText(r.daysLeft)}
                        </Badge>
                      </td>
                      <td className={inv.num}>{r.qtyOnHand}</td>
                      <td className={inv.num}>{formatPrice(r.valueMinor, r.currency)}</td>
                      <td>
                        <MarkdownCell row={r} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {near.hasNextPage ? (
          <Button
            variant="secondary"
            busy={near.isFetchingNextPage}
            onClick={() => {
              void near.fetchNextPage();
            }}
          >
            Load more
          </Button>
        ) : null}
      </Stack>

      {writeOffOpen ? (
        <ConfirmAction
          title="Write off these batches?"
          confirmLabel="Write off stock"
          danger
          onClose={() => {
            setWriteOffOpen(false);
            focus.restore();
          }}
          run={doWriteOff}
        >
          <p>
            Written-off stock leaves the shelves as a write-off adjustment and cannot be taken back.
            Only stock expiring within {String(WRITE_OFF_HORIZON_DAYS)} days, or already expired,
            can go.
          </p>
          {[...picked.values()].map((x) => (
            <TextField
              key={x.row.batchId}
              label={`Quantity to write off, ${title(x.row.variantId)}`}
              help={`On hand ${x.row.qtyOnHand}`}
              inputMode="decimal"
              value={x.qty}
              error={errors.get(x.row.batchId)}
              onChange={(e) => {
                const qty = e.target.value;
                setPicked((cur) => {
                  const next = new Map(cur);
                  const p0 = cur.get(x.row.batchId);
                  if (p0 !== undefined) next.set(x.row.batchId, { ...p0, qty });
                  return next;
                });
              }}
            />
          ))}
          <TextField
            label="Note (optional)"
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
        </ConfirmAction>
      ) : null}
    </div>
  );
}

/** Records a markdown draft for one batch. Pricing decides later; nothing changes on the shelf. */
function MarkdownCell({ row }: { readonly row: NearExpiryItem }) {
  const [result, setResult] = useState<MarkdownSuggestion | null>(null);
  const cmd = useCommand<null>(async (_, key) => {
    const r = await api<MarkdownSuggestion>("POST", "/v1/inventory/expiry/markdowns", {
      body: { locationId: row.locationId, batchId: row.batchId },
      idempotencyKey: key,
    });
    setResult(r);
  });
  return (
    <Stack>
      <Button
        variant="secondary"
        busy={cmd.busy}
        onClick={() => {
          void cmd.submit(null);
        }}
      >
        Suggest markdown
      </Button>
      {cmd.error === null ? null : <Alert tone="danger">{cmd.error}</Alert>}
      {result === null ? null : (
        <p className={inv.help}>
          <strong>{markdownText(result.percent)}</strong>. {markdownEvidenceText(result)}.
        </p>
      )}
    </Stack>
  );
}

function FefoPanel() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [range, setRange] = useState(() => defaultFefoRange(new Date().toISOString().slice(0, 10)));
  const error = fefoRangeError(range.from, range.to);
  const fefo = useFefo(t, range.from, range.to, error === null);
  const rows = useMemo(() => fefo.data?.pages.flatMap((pg) => pg.items) ?? [], [fefo.data]);
  const names = useVariantNames(t, [...new Set(rows.map((r) => r.variantId))]);

  return (
    <div role="tabpanel" id="panel-fefo" aria-labelledby="tab-fefo">
      <Stack>
        <p className={styles.muted}>
          First expired, first out. A sale or transfer that takes a later batch while an earlier one
          still holds stock is a break. Windows are up to 92 days.
        </p>
        <div className={p.grid}>
          <TextField
            label="From"
            type="date"
            value={range.from}
            error={error ?? undefined}
            onChange={(e) => {
              setRange((r) => ({ ...r, from: e.target.value }));
            }}
          />
          <TextField
            label="To"
            type="date"
            value={range.to}
            onChange={(e) => {
              setRange((r) => ({ ...r, to: e.target.value }));
            }}
          />
        </div>

        {error !== null ? null : fefo.isPending ? (
          <SkeletonRows label="Loading FEFO report" />
        ) : null}
        {fefo.isError ? (
          isNotFound(fefo.error) ? (
            <Empty title="The FEFO report is not open to your role">
              Ask an owner to grant expiry access.
            </Empty>
          ) : (
            <ErrorState
              error={fefo.error}
              onRetry={() => {
                void fefo.refetch();
              }}
            />
          )
        ) : null}
        {fefo.isSuccess && rows.length === 0 ? (
          <Empty title="No sales or transfers in this window">
            Pick a longer window to see outflows.
          </Empty>
        ) : null}

        {rows.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">FEFO compliance per product in the window</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col" className={inv.num}>
                    Outflows
                  </th>
                  <th scope="col" className={inv.num}>
                    Breaks
                  </th>
                  <th scope="col" className={inv.num}>
                    Quantity taken early
                  </th>
                  <th scope="col">Summary</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const v = names.get(r.variantId);
                  return (
                    <tr key={r.variantId}>
                      <th scope="row">
                        {v === undefined ? "Product" : `${v.productName} · ${v.name}`}
                      </th>
                      <td className={inv.num}>{r.outflows}</td>
                      <td className={inv.num}>{r.violations}</td>
                      <td className={inv.num}>{r.violatedQty}</td>
                      <td>{fefoText(r)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {fefo.hasNextPage ? (
          <Button
            variant="secondary"
            busy={fefo.isFetchingNextPage}
            onClick={() => {
              void fefo.fetchNextPage();
            }}
          >
            Load more
          </Button>
        ) : null}
      </Stack>
    </div>
  );
}
