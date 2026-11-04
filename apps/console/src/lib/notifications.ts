"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api.ts";
import { STALE } from "./queries.ts";

// ---- shapes (mirror modules/notifications/src/schemas.ts) ----

export interface AppNotification {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}
export interface NotificationPage {
  readonly notifications: AppNotification[];
  readonly next: string | null;
}
export interface Preference {
  readonly kind: string;
  readonly label: string;
  readonly inApp: boolean;
  readonly email: boolean;
}

export const notificationKeys = {
  all: (t: string) => [t, "notifications"] as const,
  unread: (t: string) => [t, "notifications", "unread"] as const,
  list: (t: string, unreadOnly: boolean) => [t, "notifications", "list", unreadOnly] as const,
  prefs: (t: string) => [t, "notifications", "prefs"] as const,
};

/** The bell checks once a minute (and when the tab regains focus); there is no push channel to the console yet. */
export const UNREAD_POLL_MS = 60_000;

export const useUnreadCount = (t: string) =>
  useQuery({
    queryKey: notificationKeys.unread(t),
    queryFn: ({ signal }) =>
      api<{ unread: number }>("GET", "/v1/notifications/unread-count", { signal }),
    staleTime: STALE.live,
    refetchInterval: UNREAD_POLL_MS,
    select: (d) => d.unread,
  });

export const useNotifications = (t: string, unreadOnly: boolean) =>
  useInfiniteQuery({
    queryKey: notificationKeys.list(t, unreadOnly),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const q = new URLSearchParams({ limit: "30", unread: String(unreadOnly) });
      if (pageParam !== null) q.set("after", pageParam);
      return api<NotificationPage>("GET", `/v1/notifications?${q.toString()}`, { signal });
    },
    getNextPageParam: (last) => last.next,
    staleTime: STALE.live,
  });

export function useMarkRead(t: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: { ids: string[] } | { all: true }) =>
      api<{ marked: number }>("POST", "/v1/notifications/read", { body: target }),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all(t) }),
  });
}

export const usePreferences = (t: string) =>
  useQuery({
    queryKey: notificationKeys.prefs(t),
    queryFn: ({ signal }) =>
      api<{ preferences: Preference[] }>("GET", "/v1/notifications/preferences", { signal }),
    staleTime: STALE.reference,
    select: (d) => d.preferences,
  });

export function useSavePreferences(t: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: readonly Pick<Preference, "kind" | "inApp" | "email">[]) =>
      api<{ preferences: Preference[] }>("PUT", "/v1/notifications/preferences", {
        body: { preferences: items },
      }),
    // Optimistic: the switch moves at once; a failure puts it back.
    onMutate: async (items) => {
      await qc.cancelQueries({ queryKey: notificationKeys.prefs(t) });
      const before = qc.getQueryData<{ preferences: Preference[] }>(notificationKeys.prefs(t));
      if (before !== undefined) {
        qc.setQueryData(notificationKeys.prefs(t), {
          preferences: before.preferences.map((p) => ({
            ...p,
            ...items.find((i) => i.kind === p.kind),
          })),
        });
      }
      return { before };
    },
    onError: (_e, _items, ctx) => {
      if (ctx?.before !== undefined) qc.setQueryData(notificationKeys.prefs(t), ctx.before);
    },
    onSuccess: (data) => {
      qc.setQueryData(notificationKeys.prefs(t), data);
    },
  });
}

/** "3" or "99+": a badge never needs more digits, and a screen reader hears the full phrase from `unreadLabel`. */
export const badgeText = (n: number): string => (n > 99 ? "99+" : String(n));

export const unreadLabel = (n: number): string =>
  n === 0 ? "Notifications" : `Notifications, ${String(n)} unread`;

/** Only in-app paths are followed: a link that is not "/something" is shown as text, never opened. */
export const safeLink = (link: string | null): `/${string}` | null =>
  link !== null && /^\/(?!\/)[A-Za-z0-9/_?=&.-]{0,200}$/.test(link) ? (link as `/${string}`) : null;

/** "just now", "5 min ago", "3 h ago", else the date. */
export function ago(iso: string, now: number): string {
  const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${String(Math.floor(secs / 60))} min ago`;
  if (secs < 86_400) return `${String(Math.floor(secs / 3600))} h ago`;
  return new Date(iso).toLocaleDateString();
}
