"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useId, useRef, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Empty,
  ErrorState,
  LinkButton,
  Row,
  SkeletonRows,
  Stack,
  cx,
  styles,
} from "@/components/ui.tsx";
import { api, isNotFound } from "@/lib/api.ts";
import { useAttemptKey } from "@/lib/procurement.ts";
import {
  PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  authorLabel,
  buildReply,
  countdownText,
  diagnosticFacts,
  replyHint,
  slaTarget,
  supportErrorText,
  supportKeys,
  ticketActions,
  useTicket,
  useViewerClock,
  visibleMessages,
  whenText,
} from "@/lib/support.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../support.module.css";

import type { SubmitEvent } from "react";

type StatusChange = "solved" | "open";

/**
 * One ticket: the thread, the SLA clock in the viewer's zone, a reply box, and solve or reopen. Internal notes are
 * filtered out here as well as on the server; diagnostics show only the app version and platform.
 */
export default function TicketPage() {
  const { id } = useParams<{ id: string }>();
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const ticket = useTicket(t, id);
  const clock = useViewerClock();
  const keyFor = useAttemptKey();
  const round = useRef(0);
  const [statusBusy, setStatusBusy] = useState<StatusChange | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [replyError, setReplyError] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (ticket.isError)
    return isNotFound(ticket.error) ? (
      <Empty title="Ticket not found">It may have been removed, or your role cannot see it.</Empty>
    ) : (
      <ErrorState
        error={ticket.error}
        onRetry={() => {
          void ticket.refetch();
        }}
      />
    );
  const x = ticket.data;
  if (ticket.isPending || x === undefined) return <SkeletonRows label="Loading ticket" />;

  const now = clock?.nowMs ?? null;
  const actions = now === null ? null : ticketActions(x, now);
  const hint = now === null ? null : replyHint(x, now);
  const sla = slaTarget(x);
  const thread = visibleMessages(x.messages);
  const facts = diagnosticFacts(x.diagnostics);

  /** Solve or reopen: one POST with the status alone. The key is tied to the version it read. */
  const changeStatus = async (to: StatusChange): Promise<void> => {
    if (statusBusy !== null) return;
    setStatusBusy(to);
    setStatusError(null);
    try {
      await api("POST", `/v1/support/tickets/${encodeURIComponent(x.id)}/status`, {
        body: { status: to },
        idempotencyKey: keyFor(`${x.id}|${to}|${x.updatedAt}`),
      });
      await qc.invalidateQueries({ queryKey: supportKeys.all(t) });
    } catch (err) {
      setStatusError(supportErrorText(err, "Could not change the status. Try again."));
    } finally {
      setStatusBusy(null);
    }
  };

  const send = async (e: SubmitEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (sending) return;
    const built = buildReply(reply);
    if (!built.ok) {
      setReplyError(built.errors.get("body"));
      return;
    }
    setReplyError(undefined);
    setSending(true);
    setSendError(null);
    try {
      await api("POST", `/v1/support/tickets/${encodeURIComponent(x.id)}/messages`, {
        body: built.body,
        // A new round after each success, so the same text sent again later is a new request, not a replay.
        idempotencyKey: keyFor(`${x.id}|${String(round.current)}|${built.body.body}`),
      });
      round.current += 1;
      setReply("");
      await qc.invalidateQueries({ queryKey: supportKeys.all(t) });
    } catch (err) {
      setSendError(supportErrorText(err, "Could not send the reply. Try again."));
    } finally {
      setSending(false);
    }
  };

  return (
    <Stack>
      <Row spread>
        <div>
          <h1>{x.subject}</h1>
          <p>
            <Badge tone={x.status === "pending" ? "warning" : "neutral"}>
              {TICKET_STATUS_LABEL[x.status]}
            </Badge>{" "}
            <span className={styles.muted}>{`${PRIORITY_LABEL[x.priority]} priority`}</span>
          </p>
        </div>
        <div className={s.actions}>
          <LinkButton variant="secondary" href="/support">
            All tickets
          </LinkButton>
          {actions?.reopen ? (
            <Button
              variant="secondary"
              busy={statusBusy === "open"}
              disabled={statusBusy !== null}
              onClick={() => {
                void changeStatus("open");
              }}
            >
              Reopen ticket
            </Button>
          ) : null}
          {actions?.solve ? (
            <Button
              busy={statusBusy === "solved"}
              disabled={statusBusy !== null}
              onClick={() => {
                void changeStatus("solved");
              }}
            >
              Mark solved
            </Button>
          ) : null}
        </div>
      </Row>

      {statusError === null ? null : <Alert tone="danger">{statusError}</Alert>}

      {sla !== null && clock !== null ? (
        <p className={s.sla}>
          <span>{`${sla.label}: `}</span>
          <time dateTime={sla.dueAt}>{whenText(sla.dueAt, clock.timeZone)}</time>
          <span className={s.countdown}>{` (${countdownText(sla.dueAt, clock.nowMs)})`}</span>
        </p>
      ) : null}

      <dl className={s.facts}>
        <dt>Opened</dt>
        <dd>
          <time dateTime={x.createdAt}>{new Date(x.createdAt).toLocaleDateString()}</time>
        </dd>
        <dt>Last update</dt>
        <dd>
          <time dateTime={x.updatedAt}>{new Date(x.updatedAt).toLocaleDateString()}</time>
        </dd>
        {facts.map((f) => (
          <div key={f.label} className={s.fact}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>

      {x.messagesTruncated ? (
        <Alert tone="info">
          This thread is too long to show in full. Some newer messages are not shown.
        </Alert>
      ) : null}

      <section aria-labelledby="thread-heading">
        <h2 id="thread-heading">Conversation</h2>
        {thread.length === 0 ? <p className={styles.muted}>No messages yet.</p> : null}
        <ol className={s.thread}>
          {thread.map((m) => (
            <li key={m.id} className={cx(s.message, m.authorKind === "platform" && s.fromSupport)}>
              <p className={s.meta}>
                <strong>{authorLabel(m.authorKind)}</strong>
                {clock === null ? null : (
                  <time
                    dateTime={m.createdAt}
                  >{` · ${whenText(m.createdAt, clock.timeZone)}`}</time>
                )}
              </p>
              <p className={s.body}>{m.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {actions === null ? null : actions.reply ? (
        <form
          className={s.form}
          aria-labelledby="reply-heading"
          onSubmit={(e) => {
            void send(e);
          }}
        >
          <h2 id="reply-heading">Reply</h2>
          {sendError === null ? null : <Alert tone="danger">{sendError}</Alert>}
          <MessageField
            label="Your reply"
            value={reply}
            help={hint ?? undefined}
            error={replyError}
            onChange={setReply}
          />
          <Row spread>
            <span />
            <Button type="submit" busy={sending}>
              Send reply
            </Button>
          </Row>
        </form>
      ) : (
        <Alert tone="info">{hint}</Alert>
      )}
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
  readonly help?: string | undefined;
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
        rows={5}
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
