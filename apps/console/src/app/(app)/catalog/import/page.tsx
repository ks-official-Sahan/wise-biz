"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  LinkButton,
  Row,
  SelectField,
  Stack,
  cx,
  styles,
} from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import {
  IMPORT_COLUMNS,
  applyMapping,
  autoMap,
  catalogKeys,
  mappingProblems,
  parseCsv,
  sha256Hex,
} from "@/lib/catalog.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../catalog.module.css";

import type { ColumnMapping } from "@/lib/catalog.ts";

const MAX_BYTES = 20 * 1024 * 1024;

interface ImportDto {
  readonly id: string;
  readonly fileName: string;
  readonly status: "awaiting_upload" | "queued" | "running" | "done" | "failed";
  readonly totalRows: number;
  readonly okRows: number;
  readonly errorRows: number;
  readonly errors: readonly { row: number; column: string; error: string }[];
  readonly failure: string | null;
  readonly reportUrl: string | null;
  readonly upload: { method: "PUT"; url: string; headers: Record<string, string> } | null;
}

/** The report is a presigned link: https or this origin only, never javascript: or data:. */
function safeHref(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url, globalThis.location.origin);
    return u.protocol === "https:" || u.origin === globalThis.location.origin ? u.href : null;
  } catch {
    return null;
  }
}

const STEPS = ["Choose file", "Match columns", "Check and import", "Result"] as const;

export default function ImportPage() {
  const { tenant } = useTenant();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImportDto | null>(null);
  const [busy, setBusy] = useState(false);
  const stop = useRef(false);
  const abort = useRef<AbortController | null>(null);
  // Read through a function: the flag is set from the unmount cleanup, which the compiler cannot see in `run`.
  const stopped = (): boolean => stop.current;

  useEffect(
    () => () => {
      stop.current = true;
      abort.current?.abort();
    },
    [],
  );

  async function choose(file: File | undefined): Promise<void> {
    setError(null);
    if (file === undefined) return;
    if (file.size > MAX_BYTES) {
      setError("This file is larger than 20 MB. Split it into smaller files.");
      return;
    }
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      setError("Choose a .csv file. In Excel or Sheets use Save as → CSV.");
      return;
    }
    try {
      const parsed = parseCsv(await file.text());
      const header = parsed[0];
      if (header === undefined || parsed.length < 2) {
        setError("The file has no products in it (it needs a header row and at least one row).");
        return;
      }
      setFileName(file.name);
      setRows(parsed);
      setMapping(autoMap(header));
      setStep(1);
    } catch (e) {
      if (stopped()) return;
      setError(e instanceof Error ? e.message : "That file could not be read.");
    }
  }

  async function run(): Promise<void> {
    if (mapping === null) return;
    setBusy(true);
    setError(null);
    stop.current = false;
    const ctl = new AbortController();
    abort.current = ctl;
    const { signal } = ctl;
    try {
      const bytes = new TextEncoder().encode(applyMapping(rows, mapping));
      if (bytes.length > MAX_BYTES) throw new Error("The mapped file is larger than 20 MB.");
      const sha256 = await sha256Hex(bytes.buffer.slice(0));
      let current = await api<ImportDto>("POST", "/v1/catalog/imports", {
        body: { fileName, sizeBytes: bytes.length, sha256 },
        signal,
      });
      if (current.status === "awaiting_upload" && current.upload !== null) {
        const put = await fetch(current.upload.url, {
          method: "PUT",
          headers: current.upload.headers,
          body: bytes,
          signal,
        });
        if (!put.ok) throw new Error("The upload failed. Check your connection and try again.");
      }
      if (current.status === "awaiting_upload")
        current = await api<ImportDto>("POST", `/v1/catalog/imports/${current.id}/start`, {
          signal,
        });
      setStep(2);
      setJob(current);
      // Poll until the workers finish (batches of 500 rows).
      const started = Date.now();
      while (!stopped() && current.status !== "done" && current.status !== "failed") {
        if (Date.now() - started > 10 * 60_000)
          throw new Error("This import is taking too long. Check back on this page later.");
        await new Promise((r) => setTimeout(r, 1500));
        current = await api<ImportDto>("GET", `/v1/catalog/imports/${current.id}`, { signal });
        setJob(current);
      }
      await qc.invalidateQueries({ queryKey: catalogKeys.all(tenant.tenantId) });
      setStep(3);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? (e.problem.detail ?? e.message)
          : e instanceof Error
            ? e.message
            : "The import failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const report = safeHref(job?.reportUrl ?? null);
  const header = rows[0] ?? [];
  const problems = mapping === null ? [] : mappingProblems(mapping);
  const previewCols = IMPORT_COLUMNS.filter(
    (c) => mapping?.[c.key] !== null && mapping?.[c.key] !== undefined,
  );

  return (
    <Stack>
      <Row spread>
        <h1>Import products</h1>
        <LinkButton variant="secondary" href="/catalog">
          Back to products
        </LinkButton>
      </Row>
      <ol className={s.stepper} aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? "step" : undefined}>
            {`${String(i + 1)}. ${label}`}
          </li>
        ))}
      </ol>
      {error === null ? null : <Alert tone="danger">{error}</Alert>}

      {step === 0 ? (
        <div className={s.dropzone}>
          <p>
            Upload a CSV with one row per variant. Only the product name and the SKU are required.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="CSV file"
            onChange={(e) => void choose(e.target.files?.[0])}
          />
          <p className="muted">
            Columns we read: {IMPORT_COLUMNS.map((c) => c.label).join(", ")}. Importing the same
            file twice never creates duplicates.
          </p>
        </div>
      ) : null}

      {step === 1 && mapping !== null ? (
        <Stack>
          <p>
            <strong>{fileName}</strong> — {String(rows.length - 1)} row(s). Tell us which column of
            your file feeds each field.
          </p>
          {IMPORT_COLUMNS.map((c) => (
            <SelectField
              key={c.key}
              label={c.required ? `${c.label} (required)` : c.label}
              value={mapping[c.key] === null ? "" : String(mapping[c.key])}
              options={[
                { value: "", label: "— not in my file —" },
                ...header.map((h, i) => ({
                  value: String(i),
                  label: h === "" ? `Column ${String(i + 1)}` : h,
                })),
              ]}
              onChange={(e) => {
                setMapping({
                  ...mapping,
                  [c.key]: e.target.value === "" ? null : Number(e.target.value),
                });
              }}
            />
          ))}
          {problems.length === 0 ? null : <Alert tone="info">{problems.join(" ")}</Alert>}
          <h2>Preview</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">First rows after matching</caption>
              <thead>
                <tr>
                  {previewCols.map((c) => (
                    <th key={c.key} scope="col">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(1, 6).map((r, i) => (
                  <tr key={String(i)}>
                    {previewCols.map((c) => (
                      <td key={c.key}>{r[mapping[c.key] ?? -1] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Row spread>
            <Button
              variant="ghost"
              onClick={() => {
                setStep(0);
              }}
            >
              Choose another file
            </Button>
            <Button disabled={problems.length > 0} busy={busy} onClick={() => void run()}>
              Check and import
            </Button>
          </Row>
        </Stack>
      ) : null}

      {step === 2 ? (
        <Stack>
          <p role="status">
            {job === null
              ? "Uploading…"
              : job.status === "queued"
                ? "Waiting for a worker…"
                : `Checking and importing… ${String(job.okRows + job.errorRows)} of ${String(job.totalRows)} rows`}
          </p>
        </Stack>
      ) : null}

      {step === 3 && job !== null ? (
        <Stack>
          {job.status === "failed" ? (
            <Alert tone="danger">{job.failure ?? "The import failed."}</Alert>
          ) : (
            <Alert tone={job.errorRows === 0 ? "success" : "info"}>
              {`${String(job.okRows)} row(s) imported${job.errorRows === 0 ? "." : `, ${String(job.errorRows)} skipped because of the problems below.`}`}
            </Alert>
          )}
          {job.errors.length === 0 ? null : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="sr-only">Rows that were not imported</caption>
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Column</th>
                    <th scope="col">Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {job.errors.map((e) => (
                    <tr key={`${String(e.row)}-${e.column}-${e.error}`}>
                      <td className="num">{e.row}</td>
                      <td>{e.column}</td>
                      <td>{e.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {job.errorRows > job.errors.length ? (
            <Badge>{`Showing the first ${String(job.errors.length)} of ${String(job.errorRows)}`}</Badge>
          ) : null}
          <Row>
            {report === null ? null : (
              <a className={cx(styles.button, styles.secondary)} href={report} rel="noreferrer">
                Download the full report
              </a>
            )}
            <LinkButton href="/catalog">See the products</LinkButton>
          </Row>
        </Stack>
      ) : null}
    </Stack>
  );
}
