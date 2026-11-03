"use client";

import Link from "next/link";
import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  ErrorState,
  Row,
  SkeletonRows,
  Stack,
  styles,
} from "@/components/ui.tsx";
import { ApiError } from "@/lib/api.ts";
import {
  ago,
  safeLink,
  useMarkRead,
  useNotifications,
  usePreferences,
  useSavePreferences,
} from "@/lib/notifications.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./notifications.module.css";

import type { Preference } from "@/lib/notifications.ts";

export default function NotificationsPage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useNotifications(t, unreadOnly);
  const mark = useMarkRead(t);
  const items = list.data?.pages.flatMap((p) => p.notifications) ?? [];
  const now = list.dataUpdatedAt;
  const anyUnread = items.some((n) => n.readAt === null);

  return (
    <Stack>
      <Row spread>
        <h1>Notifications</h1>
        <Row>
          <Button
            variant="secondary"
            aria-pressed={unreadOnly}
            onClick={() => {
              setUnreadOnly((v) => !v);
            }}
          >
            {unreadOnly ? "Showing unread" : "Show unread only"}
          </Button>
          <Button
            variant="secondary"
            disabled={!anyUnread || mark.isPending}
            onClick={() => {
              mark.mutate({ all: true });
            }}
          >
            Mark all read
          </Button>
        </Row>
      </Row>

      {mark.isError ? <Alert tone="danger">Could not mark them read. Try again.</Alert> : null}
      {list.isPending ? <SkeletonRows label="Loading notifications" /> : null}
      {list.isError ? (
        <ErrorState
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      ) : null}
      {list.isSuccess && items.length === 0 ? (
        <Empty title={unreadOnly ? "Nothing unread" : "You are all caught up"}>
          Low stock, expiring stock and finished exports show up here.
        </Empty>
      ) : null}

      {items.length > 0 ? (
        <ul className={s.list} aria-label="Notifications">
          {items.map((n) => {
            const href = safeLink(n.link);
            return (
              <li key={n.id} className={s.item} data-unread={n.readAt === null}>
                <div className={s.head}>
                  <strong>{n.title}</strong>
                  {n.readAt === null ? <Badge tone="accent">New</Badge> : null}
                  <span className={styles.muted}>{ago(n.createdAt, now)}</span>
                </div>
                <p>{n.body}</p>
                <Row>
                  {href === null ? null : (
                    <Link
                      href={href}
                      onClick={() => {
                        if (n.readAt === null) mark.mutate({ ids: [n.id] });
                      }}
                    >
                      Open
                    </Link>
                  )}
                  {n.readAt === null ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        mark.mutate({ ids: [n.id] });
                      }}
                    >
                      Mark read
                    </Button>
                  ) : null}
                </Row>
              </li>
            );
          })}
        </ul>
      ) : null}
      {list.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={list.isFetchingNextPage}
          onClick={() => {
            void list.fetchNextPage();
          }}
        >
          {list.isFetchingNextPage ? "Loading…" : "Load older"}
        </Button>
      ) : null}

      <Preferences tenantId={t} />
    </Stack>
  );
}

function Preferences({ tenantId }: { readonly tenantId: string }) {
  const prefs = usePreferences(tenantId);
  const save = useSavePreferences(tenantId);

  const change = (p: Preference, patch: Partial<Pick<Preference, "inApp" | "email">>) => {
    save.mutate([{ kind: p.kind, inApp: p.inApp, email: p.email, ...patch }]);
  };

  return (
    <Card>
      <h2>What to tell me about</h2>
      {prefs.isPending ? <SkeletonRows rows={4} label="Loading preferences" /> : null}
      {prefs.isError ? (
        <ErrorState
          error={prefs.error}
          onRetry={() => {
            void prefs.refetch();
          }}
        />
      ) : null}
      {save.isError ? (
        <Alert tone="danger">
          {save.error instanceof ApiError && save.error.status === 422
            ? "Verify your email address first, then turn email on."
            : "Could not save that. Try again."}
        </Alert>
      ) : null}
      {prefs.isSuccess ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Notification preferences</caption>
            <thead>
              <tr>
                <th scope="col">Topic</th>
                <th scope="col">In the app</th>
                <th scope="col">By email</th>
              </tr>
            </thead>
            <tbody>
              {prefs.data.map((p) => (
                <tr key={p.kind}>
                  <th scope="row">{p.label}</th>
                  <td>
                    <label className={s.toggle}>
                      <input
                        type="checkbox"
                        checked={p.inApp}
                        onChange={(e) => {
                          change(p, { inApp: e.target.checked });
                        }}
                      />
                      <span className="sr-only">{`${p.label}: in the app`}</span>
                    </label>
                  </td>
                  <td>
                    <label className={s.toggle}>
                      <input
                        type="checkbox"
                        checked={p.email}
                        onChange={(e) => {
                          change(p, { email: e.target.checked });
                        }}
                      />
                      <span className="sr-only">{`${p.label}: by email`}</span>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className={styles.muted}>
        Email goes to the address you signed in with, once it is verified.
      </p>
    </Card>
  );
}
