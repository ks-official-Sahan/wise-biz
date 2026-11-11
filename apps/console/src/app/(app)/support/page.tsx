"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";

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
  cx,
  styles,
} from "@/components/ui.tsx";
import { api } from "@/lib/api.ts";
import { useAttemptKey, useReturnFocus } from "@/lib/procurement.ts";
import {
  PRIORITY_LABEL,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_STATUS_LABEL,
  buildTicket,
  supportErrorText,
  supportKeys,
  useTickets,
} from "@/lib/support.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./support.module.css";

import type { TicketDetail, TicketStatus } from "@/lib/support.ts";
import type { SubmitEvent } from "react";

export default function SupportPage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [status, setStatus] = useState<TicketStatus | "">("");
  const [creating, setCreating] = useState(false);
  const focus = useReturnFocus();
  const tickets = useTickets(t, status);
  const rows = useMemo(() => tickets.data?.pages.flatMap((p) => p.items) ?? [], [tickets.data]);

  return (
    <Stack>
      <Row spread>
        <h1>Support</h1>
        <Button
          onClick={(e) => {
            focus.remember(e.currentTarget);
            setCreating(true);
          }}
        >
          New ticket
        </Button>
      </Row>

      <div className={s.filters}>
        <SelectField
          label="Status"
          value={status}
          options={[
            { value: "", label: "All tickets" },
            ...TICKET_STATUSES.map((x) => ({ value: x, label: TICKET_STATUS_LABEL[x] })),
          ]}
          onChange={(e) => {
            setStatus(e.target.value as TicketStatus | "");
          }}
        />
      </div>

      {tickets.isPending ? <SkeletonRows label="Loading support tickets" /> : null}
      {tickets.isError ? (
        <ErrorState
          error={tickets.error}
          onRetry={() => {
            void tickets.refetch();
          }}
        />
      ) : null}
      {tickets.isSuccess && rows.length === 0 ? (
        <Empty title={status === "" ? "No tickets yet" : "No tickets with this status"}>
          {status === ""
            ? "Open a ticket when you need help from the platform team. Include what you were doing."
            : "Try another status, or show all tickets."}
        </Empty>
      ) : null}
      {rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Support tickets, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Subject</th>
                <th scope="col">Status</th>
                <th scope="col">Priority</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id}>
                  <th scope="row">
                    <Link href={`/support/${x.id}`}>{x.subject}</Link>
                  </th>
                  <td>
                    <Badge tone={x.status === "pending" ? "warning" : "neutral"}>
                      {TICKET_STATUS_LABEL[x.status]}
                    </Badge>
                  </td>
                  <td>{PRIORITY_LABEL[x.priority]}</td>
                  <td>{new Date(x.updatedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {tickets.hasNextPage ? (
        <Button
          variant="secondary"
          busy={tickets.isFetchingNextPage}
          onClick={() => {
            void tickets.fetchNextPage();
          }}
        >
          Load more
        </Button>
      ) : null}

      {creating ? (
        <NewTicketDialog
          onClose={() => {
            setCreating(false);
            focus.restore();
          }}
        />
      ) : null}
    </Stack>
  );
}

/** A labelled multi-line field. ui.tsx has no textarea, so this matches its TextField markup and classes. */
function MessageField({
  label,
  value,
  help,
  error,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly help?: string;
  readonly error?: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  const describedBy =
    error !== undefined ? `${id}-error` : help !== undefined ? `${id}-help` : undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className={cx(styles.input, s.textarea)}
        rows={6}
        value={value}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
      {help !== undefined && error === undefined ? (
        <p id={`${id}-help`} className={styles.help}>
          {help}
        </p>
      ) : null}
      <div aria-live="polite">
        {error === undefined ? null : (
          <p id={`${id}-error`} className={styles.error}>
            <span aria-hidden>!</span>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** Opens a ticket with its first message. Creating it opens the thread. */
function NewTicketDialog({ onClose }: { readonly onClose: () => void }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const router = useRouter();
  const keyFor = useAttemptKey();
  const [subject, setSubject] = useState("");
  const [priority, setPriority] = useState("normal");
  const [body, setBody] = useState("");
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const built = buildTicket({ subject, priority, body });
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors(new Map());
    setBusy(true);
    setError(null);
    try {
      const created = await api<TicketDetail>("POST", "/v1/support/tickets", {
        body: built.body,
        idempotencyKey: keyFor(JSON.stringify(built.body)),
      });
      await qc.invalidateQueries({ queryKey: supportKeys.all(t) });
      onClose();
      router.push(`/support/${created.id}`);
    } catch (err) {
      setError(supportErrorText(err, "Could not open the ticket. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="New support ticket" onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <TextField
          label="Subject"
          value={subject}
          maxLength={200}
          error={errors.get("subject")}
          onChange={(e) => {
            setSubject(e.target.value);
          }}
        />
        <SelectField
          label="Priority"
          value={priority}
          error={errors.get("priority")}
          options={TICKET_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
          onChange={(e) => {
            setPriority(e.target.value);
          }}
        />
        <MessageField
          label="First message"
          value={body}
          help="What you need help with. Do not include passwords or card numbers."
          error={errors.get("body")}
          onChange={setBody}
        />
        <Row spread>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Open ticket
          </Button>
        </Row>
      </form>
    </Dialog>
  );
}
