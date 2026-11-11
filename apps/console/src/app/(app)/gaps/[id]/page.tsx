"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";

import { ConfirmAction } from "@/components/confirm-action.tsx";
import {
  Alert,
  Badge,
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
import { api, isNotFound } from "@/lib/api.ts";
import { useCommand } from "@/lib/command.ts";
import {
  GAP_STATUS_LABEL,
  RESOLUTION_CODES,
  RESOLUTION_LABEL,
  assigneeText,
  buildResolve,
  buildTask,
  evidenceSourceText,
  gapActions,
  gapKeys,
  gapValueText,
  gapVarianceText,
  shortageQty,
  unavailableText,
  useGap,
} from "@/lib/gaps.ts";
import { useVariantNames } from "@/lib/pricing.ts";
import { useReturnFocus, useAllLocations } from "@/lib/procurement.ts";
import { useBranches, useMembers } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import inv from "../../inventory.module.css";
import s from "../../purchasing/procurement.module.css";

import type {
  GapCase,
  GapCaseDetail,
  GapTaskResult,
  ResolutionCode,
  ResolveForm,
} from "@/lib/gaps.ts";

export default function GapPage() {
  const { id } = useParams<{ id: string }>();
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const detail = useGap(t, id);
  const focus = useReturnFocus();
  const branches = useBranches(t);
  const branchIds = useMemo(
    () => (branches.data ?? []).filter((b) => !b.archived).map((b) => b.branchId),
    [branches.data],
  );
  const locations = useAllLocations(t, branchIds);
  const members = useMembers(t);
  const memberIds = useMemo(
    () => members.data?.pages.flatMap((p) => p.members.map((m) => m.userId)) ?? [],
    [members.data],
  );
  const [resolving, setResolving] = useState(false);
  const [form, setForm] = useState<ResolveForm>({
    code: "",
    note: "",
    foundLocationId: "",
    foundQty: "",
  });
  const [fieldErrors, setFieldErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [taskErrors, setTaskErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const names = useVariantNames(t, detail.data ? [detail.data.case.variantId] : []);

  const data: GapCaseDetail | undefined = detail.data;
  const c: GapCase | undefined = data?.case;

  const refresh = () => qc.invalidateQueries({ queryKey: gapKeys.all(t) });
  const patch = (body: unknown, key: string) =>
    api<GapCase>("PATCH", `/v1/inventory/gap-cases/${encodeURIComponent(id)}`, {
      body,
      idempotencyKey: key,
    });

  const investigate = useCommand<null>(async (_, key) => {
    if (c === undefined) return;
    await patch({ version: c.version, status: "investigating" }, key);
    await refresh();
  });

  const assign = useCommand<string>(async (assigneeId, key) => {
    if (c === undefined) return;
    await patch({ version: c.version, assigneeId: assigneeId === "" ? null : assigneeId }, key);
    await refresh();
  });

  const addTask = useCommand<null>(async (_, key) => {
    if (c === undefined) return;
    const built = buildTask(c.version, taskTitle, taskAssignee === "" ? null : taskAssignee);
    if (!built.ok) {
      setTaskErrors(built.errors);
      throw new Error("Check the highlighted fields.");
    }
    setTaskErrors(new Map());
    await api<GapTaskResult>("POST", `/v1/inventory/gap-cases/${encodeURIComponent(id)}/tasks`, {
      body: built.body,
      idempotencyKey: key,
    });
    setTaskTitle("");
    setTaskAssignee("");
    await refresh();
  });

  const toggleTask = useCommand<{ taskId: string; done: boolean }>(async (arg, key) => {
    if (c === undefined) return;
    await api<GapTaskResult>(
      "PATCH",
      `/v1/inventory/gap-cases/${encodeURIComponent(id)}/tasks/${encodeURIComponent(arg.taskId)}`,
      { body: { version: c.version, done: arg.done }, idempotencyKey: key },
    );
    await refresh();
  });

  const resolve = (key: string): Promise<unknown> => {
    if (c === undefined) return Promise.resolve();
    const built = buildResolve(c.version, form, shortageQty(c.varianceQty));
    if (!built.ok) {
      setFieldErrors(built.errors);
      return Promise.reject(new Error("Check the highlighted fields."));
    }
    setFieldErrors(new Map());
    return api<GapCase>("POST", `/v1/inventory/gap-cases/${encodeURIComponent(id)}/resolve`, {
      body: built.body,
      idempotencyKey: key,
    }).then(refresh);
  };

  if (detail.isPending || data === undefined || c === undefined)
    return detail.isError ? (
      isNotFound(detail.error) ? (
        <Empty title="Gap case not found">
          It may have been removed, or your role cannot see it.
        </Empty>
      ) : (
        <ErrorState
          error={detail.error}
          onRetry={() => {
            void detail.refetch();
          }}
        />
      )
    ) : (
      <SkeletonRows label="Loading stock gap" />
    );

  const actions = gapActions(c.status);
  const v = names.get(c.variantId);
  const title = v === undefined ? "Product" : `${v.productName} · ${v.name}`;
  const locationLabel = (locationId: string): string => {
    const loc = locations.find((l) => l.locationId === locationId);
    if (loc === undefined) return "…";
    const branch = branches.data?.find((b) => b.branchId === loc.branchId)?.name ?? "";
    return `${branch} · ${loc.name}`;
  };
  const unavailable = unavailableText(data.evidence.unavailable);
  const resolved = c.status === "resolved";

  return (
    <Stack>
      <Row spread>
        <div>
          <h1>{title}</h1>
          <p className={styles.muted}>{locationLabel(c.locationId)}</p>
        </div>
        <div className={s.actions}>
          <LinkButton variant="secondary" href="/gaps">
            All gaps
          </LinkButton>
          {actions.investigate ? (
            <Button
              variant="secondary"
              busy={investigate.busy}
              onClick={() => {
                void investigate.submit(null);
              }}
            >
              Start investigating
            </Button>
          ) : null}
          {actions.resolve ? (
            <Button
              onClick={(e) => {
                focus.remember(e.currentTarget);
                setFieldErrors(new Map());
                setResolving(true);
              }}
            >
              Resolve case
            </Button>
          ) : null}
        </div>
      </Row>

      {investigate.error === null ? null : <Alert tone="danger">{investigate.error}</Alert>}
      {assign.error === null ? null : <Alert tone="danger">{assign.error}</Alert>}
      {toggleTask.error === null ? null : <Alert tone="danger">{toggleTask.error}</Alert>}

      <Card>
        <Stack>
          <Row spread>
            <Badge tone={c.status === "open" ? "warning" : "neutral"}>
              {GAP_STATUS_LABEL[c.status]}
            </Badge>
            <span>{gapVarianceText(c.varianceQty)}</span>
          </Row>
          <dl className={inv.summary}>
            <div>
              <dt>Shortage value</dt>
              <dd>{gapValueText(c.valueMinor, c.currency)}</dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd>{`${c.windowFrom.slice(0, 10)} to ${c.windowTo.slice(0, 10)}`}</dd>
            </div>
            <div>
              <dt>Assignee</dt>
              <dd>{assigneeText(c.assigneeId)}</dd>
            </div>
            {c.resolutionCode === null ? null : (
              <div>
                <dt>Resolution</dt>
                <dd>
                  {RESOLUTION_LABEL[c.resolutionCode]}
                  {c.resolutionNote === "" ? "" : `, ${c.resolutionNote}`}
                </dd>
              </div>
            )}
          </dl>
        </Stack>
      </Card>

      {resolved ? null : (
        <div className={s.grid}>
          <SelectField
            label="Assignee"
            value={c.assigneeId ?? ""}
            options={[
              { value: "", label: "Unassigned" },
              ...memberIds.map((m) => ({ value: m, label: `Member ${m.slice(0, 8)}…` })),
            ]}
            onChange={(e) => {
              void assign.submit(e.target.value);
            }}
          />
        </div>
      )}

      <h2>Tasks</h2>
      {data.tasks.length === 0 ? (
        <Empty title="No tasks yet">Add a task to split the investigation.</Empty>
      ) : (
        <ul className={inv.list} aria-label="Tasks">
          {data.tasks.map((task) => (
            <li key={task.id} className={inv.item}>
              <label className={inv.check}>
                <input
                  type="checkbox"
                  checked={task.done}
                  disabled={resolved}
                  aria-label={`Done: ${task.title}`}
                  onChange={(e) => {
                    void toggleTask.submit({ taskId: task.id, done: e.target.checked });
                  }}
                />
              </label>
              <span>{task.title}</span>{" "}
              <span className={styles.muted}>
                {task.done ? "Done" : "Open"} · {assigneeText(task.assigneeId)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {resolved ? null : (
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void addTask.submit(null);
          }}
        >
          {addTask.error === null ? null : <Alert tone="danger">{addTask.error}</Alert>}
          <TextField
            label="Task"
            value={taskTitle}
            error={taskErrors.get("title")}
            onChange={(e) => {
              setTaskTitle(e.target.value);
            }}
          />
          <SelectField
            label="Assign to (optional)"
            value={taskAssignee}
            options={[
              { value: "", label: "Nobody" },
              ...memberIds.map((m) => ({ value: m, label: `Member ${m.slice(0, 8)}…` })),
            ]}
            onChange={(e) => {
              setTaskAssignee(e.target.value);
            }}
          />
          <Row spread>
            <span />
            <Button type="submit" busy={addTask.busy}>
              Add task
            </Button>
          </Row>
        </form>
      )}

      <h2>Evidence in the count window</h2>
      {unavailable === null ? null : <p className={inv.help}>{unavailable}</p>}
      {data.evidence.items.length === 0 ? (
        <Empty title="No events in this window">
          Nothing in the stock ledger or sales explains this line between the count opening and
          closing.
        </Empty>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">
              Events that fell in the count window, newest first
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Source</th>
                <th scope="col">Event</th>
                <th scope="col" className={inv.num}>
                  Quantity
                </th>
                <th scope="col">Actor</th>
                <th scope="col">Reference</th>
              </tr>
            </thead>
            <tbody>
              {data.evidence.items.map((e) => (
                <tr key={`${e.source}|${e.ref}|${e.occurredAt}`}>
                  <td className={inv.nowrap}>{e.occurredAt.replace("T", " ").slice(0, 16)}</td>
                  <td>{evidenceSourceText(e.source)}</td>
                  <td>{e.kind.replace(/_/g, " ")}</td>
                  <td className={inv.num}>{e.qty ?? "…"}</td>
                  <td>{e.actorId === null ? "Unknown" : `Member ${e.actorId.slice(0, 8)}…`}</td>
                  <td>{e.ref}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.evidence.truncated ? (
        <p className={inv.help}>
          Only the newest 200 events are shown. Older events exist in the window.
        </p>
      ) : null}

      {resolving ? (
        <ConfirmAction
          title="Resolve this case?"
          confirmLabel="Resolve case"
          onClose={() => {
            setResolving(false);
            focus.restore();
          }}
          run={resolve}
        >
          <p>A resolved case cannot be reopened. Tasks and evidence stay on the record.</p>
          <SelectField
            label="Resolution"
            value={form.code}
            error={fieldErrors.get("code")}
            options={[
              { value: "", label: "Pick a resolution" },
              ...RESOLUTION_CODES.map((x) => ({ value: x, label: RESOLUTION_LABEL[x] })),
            ]}
            onChange={(e) => {
              setForm((f) => ({ ...f, code: e.target.value as ResolutionCode | "" }));
            }}
          />
          <TextField
            label="Note (optional)"
            value={form.note}
            error={fieldErrors.get("note")}
            onChange={(e) => {
              setForm((f) => ({ ...f, note: e.target.value }));
            }}
          />
          {form.code === "misplaced_found" ? (
            <Stack>
              <SelectField
                label="Where it was found"
                value={form.foundLocationId}
                error={fieldErrors.get("foundLocationId")}
                options={[
                  { value: "", label: "Pick a location" },
                  ...locations
                    .filter((l) => !l.archived)
                    .map((l) => ({ value: l.locationId, label: locationLabel(l.locationId) })),
                ]}
                onChange={(e) => {
                  setForm((f) => ({ ...f, foundLocationId: e.target.value }));
                }}
              />
              <TextField
                label="Quantity found"
                inputMode="decimal"
                help={`At most the shortage, ${shortageQty(c.varianceQty)}.`}
                value={form.foundQty}
                error={fieldErrors.get("foundQty")}
                onChange={(e) => {
                  setForm((f) => ({ ...f, foundQty: e.target.value }));
                }}
              />
            </Stack>
          ) : null}
        </ConfirmAction>
      ) : null}
    </Stack>
  );
}
