"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { api } from "./api.ts";

/** What /v1/auth/get-session answers for a signed-in user (null when signed out). */
export interface AuthSession {
  readonly session: { readonly id: string; readonly activeTenantId?: string | null };
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
}

export const sessionKey = ["me", "session"] as const;

/**
 * Session reader for signed-in pages. Plain TanStack Query over the Better Auth endpoint, so the app shell does not
 * ship the auth client (passkey and two-factor code load only on the sign-in and sign-up pages).
 */
export function useSession() {
  const q = useQuery({
    queryKey: sessionKey,
    queryFn: ({ signal }) => api<AuthSession | null>("GET", "/v1/auth/get-session", { signal }),
    staleTime: 60_000,
  });
  const { data, isPending, refetch } = q;
  return useMemo(() => ({ data: data ?? null, isPending, refetch }), [data, isPending, refetch]);
}

/** Ends the session and forgets every cached query, so nothing of the previous user survives. */
export function useSignOut(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    await api("POST", "/v1/auth/sign-out", { body: {} });
    qc.clear();
  }, [qc]);
}
