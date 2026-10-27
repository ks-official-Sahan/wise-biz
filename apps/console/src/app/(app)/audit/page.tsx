"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import {
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorState,
  Row,
  SkeletonRows,
  Stack,
  TextField,
  styles,
  cx,
} from "@/components/ui.tsx";
import { diffJson, show } from "@/lib/diff.ts";
import { auditQueryString, useAudit, useAuditEntry } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import type { AuditFilter } from "@/lib/queries.ts";

const FIELDS = ["actor", "action", "entity", "from", "to"] as const;

/** datetime-local value (local time) to an ISO instant the API accepts. */
const toIso = (local: string): string | undefined =>
  local === "" ? undefined : new Date(local).toISOString();

function Entry({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { tenant } = useTenant();
  const entry = useAuditEntry(tenant.tenantId, id);
  const changes = entry.data ? diffJson(entry.data.before, entry.data.after) : [];
  return (
    <Dialog open={id !== null} side title="Change detail" onClose={onClose}>
      {entry.isPending ? (
        <SkeletonRows label="Loading entry" />
      ) : entry.isError ? (
        <ErrorState error={entry.error} onRetry={() => void entry.refetch()} />
      ) : (
        <Stack>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "max-content 1fr",
              gap: "8px 16px",
              margin: 0,
            }}
          >
            <dt className="muted">When</dt>
            <dd style={{ margin: 0 }}>{new Date(entry.data.at).toLocaleString()}</dd>
            <dt className="muted">Who</dt>
            <dd style={{ margin: 0 }} className="num">
              {entry.data.actor.type} {entry.data.actor.id}
            </dd>
            <dt className="muted">Action</dt>
            <dd style={{ margin: 0 }}>{entry.data.action}</dd>
            <dt className="muted">Record</dt>
            <dd style={{ margin: 0 }} className="num">
              {entry.data.entity.type} {entry.data.entity.id ?? ""}
            </dd>
            <dt className="muted">Request</dt>
            <dd style={{ margin: 0 }} className="num">
              {entry.data.requestId}
            </dd>
            <dt className="muted">Integrity</dt>
            <dd style={{ margin: 0 }}>
              {entry.data.chained ? (
                <Badge tone="accent">Sealed in the hash chain</Badge>
              ) : (
                <Badge>Pending seal</Badge>
              )}
            </dd>
          </dl>
          <h3>What changed</h3>
          {changes.length === 0 ? (
            <p className="muted">No field-level changes recorded.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={c.path}>
                      <td className="num">{c.path}</td>
                      <td>
                        <del style={{ color: "var(--wb-color-danger-text)" }}>{show(c.before)}</del>
                      </td>
                      <td>
                        <ins
                          style={{ color: "var(--wb-color-success-text)", textDecoration: "none" }}
                        >
                          {show(c.after)}
                        </ins>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Stack>
      )}
    </Dialog>
  );
}

function AuditView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { tenant } = useTenant();
  const filter: { -readonly [K in keyof AuditFilter]: AuditFilter[K] } = {};
  for (const f of FIELDS) {
    const v = params.get(f);
    if (v !== null) filter[f] = v;
  }
  const exportLink = useRef<HTMLAnchorElement>(null);
  const audit = useAudit(tenant.tenantId, filter);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ actor: "", action: "", entity: "", from: "", to: "" });
  const rows = audit.data?.pages.flatMap((p) => p.entries) ?? [];

  // The command palette opens /audit?export=1: download once, then drop the flag so Back does not repeat it.
  const exportRequested = params.get("export") === "1";
  useEffect(() => {
    if (!exportRequested) return;
    exportLink.current?.click();
    const rest = new URLSearchParams(params);
    rest.delete("export");
    const qs = rest.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}` as never);
  }, [exportRequested, params, pathname, router]);

  const apply = (): void => {
    const next = new URLSearchParams();
    if (form.actor) next.set("actor", form.actor.trim());
    if (form.action) next.set("action", form.action.trim());
    if (form.entity) next.set("entity", form.entity.trim());
    const from = toIso(form.from);
    const to = toIso(form.to);
    if (from) next.set("from", from);
    if (to) next.set("to", to);
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}` as never);
  };

  return (
    <Stack>
      <Row spread>
        <h1>Audit log</h1>
        <a
          ref={exportLink}
          className={cx(styles.button, styles.secondary)}
          href={`/v1/audit/export${auditQueryString(filter)}`}
          download
        >
          Export CSV
        </a>
      </Row>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
        aria-label="Filter the audit log"
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          alignItems: "end",
        }}
      >
        <TextField
          label="Who (user id)"
          value={form.actor}
          onChange={(e) => {
            setForm({ ...form, actor: e.target.value });
          }}
        />
        <TextField
          label="Action"
          placeholder="tenancy.branch.updated"
          value={form.action}
          onChange={(e) => {
            setForm({ ...form, action: e.target.value });
          }}
        />
        <TextField
          label="Record type"
          placeholder="tenancy.branch"
          value={form.entity}
          onChange={(e) => {
            setForm({ ...form, entity: e.target.value });
          }}
        />
        <TextField
          label="From"
          type="datetime-local"
          value={form.from}
          onChange={(e) => {
            setForm({ ...form, from: e.target.value });
          }}
        />
        <TextField
          label="To"
          type="datetime-local"
          value={form.to}
          onChange={(e) => {
            setForm({ ...form, to: e.target.value });
          }}
        />
        <Row>
          <Button type="submit">Apply</Button>
          <Button
            variant="ghost"
            onClick={() => {
              setForm({ actor: "", action: "", entity: "", from: "", to: "" });
              router.replace(pathname);
            }}
          >
            Clear
          </Button>
        </Row>
      </form>
      {audit.isPending ? (
        <SkeletonRows label="Loading the audit log" rows={8} />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : rows.length === 0 ? (
        <Empty title="Nothing matches">
          Change or clear the filters. New changes show here as they happen.
        </Empty>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Audit entries, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Record</th>
                <th scope="col">Who</th>
                <th scope="col">
                  <span className="sr-only">Detail</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="num">{new Date(r.at).toLocaleString()}</td>
                  <td>{r.action}</td>
                  <td>{r.entity.type}</td>
                  <td className="num">{r.actor.id.slice(0, 8)}</td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setOpen(r.id);
                      }}
                      aria-label={`Open ${r.action} at ${new Date(r.at).toLocaleString()}`}
                    >
                      Details
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {audit.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            busy={audit.isFetchingNextPage}
            onClick={() => void audit.fetchNextPage()}
          >
            Load older
          </Button>
        </div>
      ) : null}
      <Entry
        id={open}
        onClose={() => {
          setOpen(null);
        }}
      />
    </Stack>
  );
}

export default function AuditPage() {
  return (
    <Suspense>
      <AuditView />
    </Suspense>
  );
}
