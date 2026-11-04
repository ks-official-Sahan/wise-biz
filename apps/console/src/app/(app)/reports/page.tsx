"use client";

import { useState } from "react";

import { BarChart } from "@/components/bar-chart.tsx";
import {
  Alert,
  Button,
  Card,
  Empty,
  ErrorState,
  LinkButton,
  Row,
  SelectField,
  SkeletonRows,
  Stack,
  TextField,
  styles,
} from "@/components/ui.tsx";
import { ApiError } from "@/lib/api.ts";
import { formatPrice } from "@/lib/pricing.ts";
import { useBranches, useProfile } from "@/lib/queries.ts";
import {
  PRESETS,
  dailySeries,
  presetRange,
  salesCsvUrl,
  totals,
  exportDownloadUrl,
  exportStatusText,
  hourLabel,
  operatorLabel,
  useExports,
  useRequestExport,
  useHoursReport,
  useOperatorsReport,
  usePaymentsReport,
  useProductsReport,
  useSalesReport,
  useTaxReport,
} from "@/lib/reports.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../ops.module.css";

import type { GroupBy, PresetId, ReportFilter } from "@/lib/reports.ts";

const TABS = [
  { id: "sales", label: "Sales" },
  { id: "products", label: "Products" },
  { id: "payments", label: "Payments" },
  { id: "hours", label: "Hours" },
  { id: "staff", label: "Staff" },
  { id: "exports", label: "Exports" },
  { id: "tax", label: "Tax" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function ReportsPage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const branches = useBranches(t);
  const currency = useProfile(t).data?.currency ?? "";
  const [tab, setTab] = useState<TabId>("sales");
  const [preset, setPreset] = useState<PresetId>("30d");
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [branchId, setBranchId] = useState("");
  const range = custom ?? presetRange(preset);
  const filter: ReportFilter = { ...range, ...(branchId === "" ? {} : { branchId }) };
  const invalid = filter.from > filter.to;

  return (
    <Stack>
      <Row spread>
        <h1>Reports</h1>
      </Row>
      <div className={s.grid}>
        <SelectField
          label="Period"
          value={custom === null ? preset : "custom"}
          options={[
            ...PRESETS.map((p) => ({ value: p.id, label: p.label })),
            { value: "custom", label: "Custom dates" },
          ]}
          onChange={(e) => {
            if (e.target.value === "custom") setCustom(range);
            else {
              setCustom(null);
              setPreset(e.target.value as PresetId);
            }
          }}
        />
        <SelectField
          label="Branch"
          value={branchId}
          options={[
            { value: "", label: "All branches" },
            ...(branches.data ?? []).map((b) => ({ value: b.branchId, label: b.name })),
          ]}
          onChange={(e) => {
            setBranchId(e.target.value);
          }}
        />
        {custom === null ? null : (
          <>
            <TextField
              label="From"
              type="date"
              value={custom.from}
              onChange={(e) => {
                setCustom({ ...custom, from: e.target.value });
              }}
            />
            <TextField
              label="To"
              type="date"
              value={custom.to}
              error={invalid ? "Must not be before the start." : undefined}
              onChange={(e) => {
                setCustom({ ...custom, to: e.target.value });
              }}
            />
          </>
        )}
      </div>
      <p className={styles.muted}>
        Days are the business day of each branch, up to 366 days at a time.
      </p>

      <div className={s.tabs} role="tablist" aria-label="Reports">
        {TABS.map((x, i) => (
          <button
            key={x.id}
            id={`rep-tab-${x.id}`}
            type="button"
            role="tab"
            className={s.tab}
            aria-selected={tab === x.id}
            aria-controls={tab === x.id ? "rep-panel" : undefined}
            tabIndex={tab === x.id ? 0 : -1}
            onClick={() => {
              setTab(x.id);
            }}
            onKeyDown={(e) => {
              const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (step === 0) return;
              const next = TABS[(i + step + TABS.length) % TABS.length];
              if (next === undefined) return;
              setTab(next.id);
              document.getElementById(`rep-tab-${next.id}`)?.focus();
            }}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div id="rep-panel" role="tabpanel" aria-labelledby={`rep-tab-${tab}`}>
        {invalid || currency === "" ? (
          <SkeletonRows label="Waiting for the period" rows={2} />
        ) : tab === "sales" ? (
          <SalesTab filter={filter} currency={currency} />
        ) : tab === "products" ? (
          <ProductsTab filter={filter} currency={currency} />
        ) : tab === "payments" ? (
          <PaymentsTab filter={filter} currency={currency} />
        ) : tab === "hours" ? (
          <HoursTab filter={filter} currency={currency} />
        ) : tab === "staff" ? (
          <StaffTab filter={filter} currency={currency} />
        ) : tab === "exports" ? (
          <ExportsTab filter={filter} />
        ) : (
          <TaxTab filter={filter} currency={currency} />
        )}
      </div>
    </Stack>
  );
}

function SalesTab({ filter, currency }: { filter: ReportFilter; currency: string }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [by, setBy] = useState<GroupBy>("day");
  const daily = useSalesReport(t, filter, "day");
  const grouped = useSalesReport(t, filter, by, by !== "day");
  const branches = useBranches(t);
  const m = (minor: number) => formatPrice(minor, currency);
  const rows = (by === "day" ? daily.data : grouped.data) ?? [];
  const name = new Map((branches.data ?? []).map((b) => [b.branchId, b.name]));

  if (daily.isPending) return <SkeletonRows label="Loading sales" />;
  if (daily.isError)
    return (
      <ErrorState
        error={daily.error}
        onRetry={() => {
          void daily.refetch();
        }}
      />
    );
  const sum = totals(daily.data, currency);
  const series = dailySeries(daily.data, filter.from, filter.to, currency);
  if (sum.salesCount === 0 && sum.voidsCount === 0)
    return <Empty title="No sales in this period">Try a wider period or another branch.</Empty>;

  return (
    <Stack>
      <div className={s.grid}>
        <Kpi label="Net sales" value={m(sum.netMinor)} />
        <Kpi label="Sales" value={String(sum.salesCount)} />
        <Kpi label="Average sale" value={m(sum.averageMinor)} />
        <Kpi label="Returns" value={m(sum.returnsMinor)} />
        <Kpi label="Tax" value={m(sum.taxMinor)} />
        <Kpi label="Voided sales" value={String(sum.voidsCount)} />
      </div>
      <Card>
        <BarChart series={series} label="Net sales per day" format={m} />
      </Card>
      <Row spread>
        <SelectField
          label="Break down by"
          value={by}
          options={[
            { value: "day", label: "Day" },
            { value: "branch", label: "Branch" },
            { value: "terminal", label: "Terminal" },
          ]}
          onChange={(e) => {
            setBy(e.target.value as GroupBy);
          }}
        />
        <LinkButton variant="secondary" href={salesCsvUrl(filter, by)}>
          Download CSV
        </LinkButton>
      </Row>
      {by !== "day" && grouped.isPending ? (
        <SkeletonRows label="Loading breakdown" rows={3} />
      ) : null}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">Sales by {by}</caption>
          <thead>
            <tr>
              <th scope="col">{by === "day" ? "Day" : by === "branch" ? "Branch" : "Terminal"}</th>
              <th scope="col" className={s.num}>
                Sales
              </th>
              <th scope="col" className={s.num}>
                Paid
              </th>
              <th scope="col" className={s.num}>
                Returns
              </th>
              <th scope="col" className={s.num}>
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((r) => r.currency === currency)
              .map((r) => (
                <tr key={r.key}>
                  <th scope="row">
                    {by === "branch"
                      ? (name.get(r.key) ?? r.key.slice(0, 8))
                      : by === "terminal"
                        ? r.key.slice(0, 8)
                        : r.key}
                  </th>
                  <td className={s.num}>{r.salesCount}</td>
                  <td className={s.num}>{m(r.payableMinor)}</td>
                  <td className={s.num}>{m(r.returnsMinor)}</td>
                  <td className={s.num}>{m(r.netMinor)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </Stack>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <Stack>
        <span className="muted">{label}</span>
        <span className="num" style={{ fontSize: "var(--wb-font-size-xl)", fontWeight: 600 }}>
          {value}
        </span>
      </Stack>
    </Card>
  );
}

function ProductsTab({ filter, currency }: { filter: ReportFilter; currency: string }) {
  const { tenant } = useTenant();
  const report = useProductsReport(tenant.tenantId, filter);
  const m = (minor: number) => formatPrice(minor, currency);
  if (report.isPending) return <SkeletonRows label="Loading products" />;
  if (report.isError)
    return (
      <ErrorState
        error={report.error}
        onRetry={() => {
          void report.refetch();
        }}
      />
    );
  const rows = report.data.filter((r) => r.currency === currency);
  if (rows.length === 0) return <Empty title="No product sales in this period" />;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="sr-only">Best-selling products by revenue</caption>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col" className={s.num}>
              Sold
            </th>
            <th scope="col" className={s.num}>
              Revenue
            </th>
            <th scope="col" className={s.num}>
              Cost
            </th>
            <th scope="col" className={s.num}>
              Profit
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.variantId}>
              <th scope="row">{r.sku}</th>
              <td className={s.num}>{r.qty.includes(".") ? r.qty.replace(/\.?0+$/, "") : r.qty}</td>
              <td className={s.num}>{m(r.revenueMinor)}</td>
              <td className={s.num}>{m(r.costMinor)}</td>
              <td className={s.num}>{m(r.profitMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.muted}>
        Revenue includes tax. Profit is revenue without tax, minus cost; products with no recorded
        cost show a cost of zero.
      </p>
    </div>
  );
}

function PaymentsTab({ filter, currency }: { filter: ReportFilter; currency: string }) {
  const { tenant } = useTenant();
  const report = usePaymentsReport(tenant.tenantId, filter);
  const m = (minor: number) => formatPrice(minor, currency);
  if (report.isPending) return <SkeletonRows label="Loading payments" />;
  if (report.isError)
    return (
      <ErrorState
        error={report.error}
        onRetry={() => {
          void report.refetch();
        }}
      />
    );
  const rows = report.data.filter((r) => r.currency === currency);
  if (rows.length === 0) return <Empty title="No payments in this period" />;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="sr-only">Payments by type</caption>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col" className={s.num}>
              Payments
            </th>
            <th scope="col" className={s.num}>
              Taken
            </th>
            <th scope="col" className={s.num}>
              Refunded
            </th>
            <th scope="col" className={s.num}>
              Net
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.kind}>
              <th scope="row">{r.kind.replace(/_/g, " ")}</th>
              <td className={s.num}>{r.count}</td>
              <td className={s.num}>{m(r.salesMinor)}</td>
              <td className={s.num}>{m(r.refundsMinor)}</td>
              <td className={s.num}>{m(r.netMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExportsTab({ filter }: { filter: ReportFilter }) {
  const { tenant } = useTenant();
  const list = useExports(tenant.tenantId);
  const request = useRequestExport(tenant.tenantId);
  return (
    <Stack>
      <Card>
        <h2>Sale lines</h2>
        <p className={styles.muted}>
          {`Every sold line from ${filter.from} to ${filter.to}, one row each, as a compressed CSV. Big files are built in the background and you are told when one is ready.`}
        </p>
        {request.isError ? (
          <Alert tone="danger">
            {request.error instanceof ApiError && request.error.status === 404
              ? "Exports are for people who can see every branch."
              : "Could not start the export. Try again."}
          </Alert>
        ) : null}
        <Button
          disabled={request.isPending}
          onClick={() => {
            request.mutate(filter);
          }}
        >
          {request.isPending ? "Requesting…" : "Request export"}
        </Button>
      </Card>
      {list.isPending ? <SkeletonRows label="Loading exports" rows={3} /> : null}
      {list.isError ? (
        <ErrorState
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      ) : null}
      {list.isSuccess && list.data.length === 0 ? <Empty title="No exports yet" /> : null}
      {list.isSuccess && list.data.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Your recent exports</caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((e) => (
                <tr key={e.id}>
                  <th scope="row">{`${e.from} to ${e.to}`}</th>
                  <td>
                    <span role={e.status === "failed" ? "alert" : undefined}>
                      {exportStatusText(e)}
                    </span>
                  </td>
                  <td>
                    {e.downloadable ? (
                      <a href={exportDownloadUrl(e.id)} download>
                        Download
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Stack>
  );
}

function HoursTab({ filter, currency }: { filter: ReportFilter; currency: string }) {
  const { tenant } = useTenant();
  const report = useHoursReport(tenant.tenantId, filter);
  const m = (minor: number) => formatPrice(minor, currency);
  if (report.isPending) return <SkeletonRows label="Loading sales by hour" />;
  if (report.isError)
    return (
      <ErrorState
        error={report.error}
        onRetry={() => {
          void report.refetch();
        }}
      />
    );
  const rows = report.data.filter((r) => r.currency === currency && r.salesCount > 0);
  if (rows.length === 0) return <Empty title="No sales by hour in this period" />;
  const peak = Math.max(...rows.map((r) => r.salesCount));
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="sr-only">Sales by hour of the local day</caption>
        <thead>
          <tr>
            <th scope="col">Hour</th>
            <th scope="col" className={s.num}>
              Sales
            </th>
            <th scope="col" className={s.num}>
              Taken
            </th>
            <th scope="col">Share of busiest hour</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.hour}>
              <th scope="row">{hourLabel(r.hour)}</th>
              <td className={s.num}>{r.salesCount}</td>
              <td className={s.num}>{m(r.payableMinor)}</td>
              <td>
                <meter min={0} max={peak} value={r.salesCount} aria-label={hourLabel(r.hour)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StaffTab({ filter, currency }: { filter: ReportFilter; currency: string }) {
  const { tenant } = useTenant();
  const report = useOperatorsReport(tenant.tenantId, filter);
  const m = (minor: number) => formatPrice(minor, currency);
  if (report.isPending) return <SkeletonRows label="Loading staff sales" />;
  if (report.isError)
    return (
      <ErrorState
        error={report.error}
        onRetry={() => {
          void report.refetch();
        }}
      />
    );
  const rows = report.data.filter((r) => r.currency === currency);
  if (rows.length === 0) return <Empty title="No sales in this period" />;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="sr-only">Sales by staff member</caption>
        <thead>
          <tr>
            <th scope="col">Staff</th>
            <th scope="col" className={s.num}>
              Sales
            </th>
            <th scope="col" className={s.num}>
              Taken
            </th>
            <th scope="col" className={s.num}>
              Average
            </th>
            <th scope="col" className={s.num}>
              Discounts
            </th>
            <th scope="col" className={s.num}>
              Voids
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.operatorId}>
              <th scope="row">{operatorLabel(r.operatorId)}</th>
              <td className={s.num}>{r.salesCount}</td>
              <td className={s.num}>{m(r.payableMinor)}</td>
              <td className={s.num}>{m(r.averageMinor)}</td>
              <td className={s.num}>{m(r.discountMinor)}</td>
              <td className={s.num}>{`${String(r.voidsCount)} (${m(r.voidsPayableMinor)})`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaxTab({ filter, currency }: { filter: ReportFilter; currency: string }) {
  const { tenant } = useTenant();
  const report = useTaxReport(tenant.tenantId, filter);
  const m = (minor: number) => formatPrice(minor, currency);
  if (report.isPending) return <SkeletonRows label="Loading tax" />;
  if (report.isError)
    return (
      <ErrorState
        error={report.error}
        onRetry={() => {
          void report.refetch();
        }}
      />
    );
  const rows = report.data.filter((r) => r.currency === currency);
  if (rows.length === 0) return <Empty title="No tax collected in this period" />;
  const total = rows.reduce((n, r) => n + r.taxMinor, 0);
  return (
    <Stack>
      <Kpi label="Tax collected" value={m(total)} />
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">Tax by day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col" className={s.num}>
                Sales without tax
              </th>
              <th scope="col" className={s.num}>
                Tax
              </th>
              <th scope="col" className={s.num}>
                Sales with tax
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.day}>
                <th scope="row">{r.day}</th>
                <td className={s.num}>{m(r.netOfTaxMinor)}</td>
                <td className={s.num}>{m(r.taxMinor)}</td>
                <td className={s.num}>{m(r.payableMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Stack>
  );
}
