"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api.ts";

import type {
  AuditDetail,
  AuditEntry,
  Branch,
  Invite,
  Location,
  Member,
  MyTenant,
  OnboardingDraft,
  Profile,
  Role,
} from "./types.ts";

/** staleTime by data class (ux.md performance): reference data changes rarely, lists often, the audit log always. */
export const STALE = { reference: 5 * 60_000, list: 30_000, live: 0 } as const;

/**
 * Query keys. Everything tenant-owned starts with the tenant id, so switching tenants can never show another tenant's
 * cached rows, and invalidating one tenant is one prefix.
 */
export const keys = {
  me: ["me"] as const,
  myTenants: ["me", "tenants"] as const,
  tenant: (t: string) => [t] as const,
  profile: (t: string) => [t, "profile"] as const,
  onboarding: (t: string) => [t, "onboarding"] as const,
  branches: (t: string) => [t, "branches"] as const,
  locations: (t: string, branchId: string) => [t, "branches", branchId, "locations"] as const,
  members: (t: string) => [t, "members"] as const,
  invites: (t: string) => [t, "invites"] as const,
  roles: (t: string) => [t, "roles"] as const,
  audit: (t: string, filter: AuditFilter) => [t, "audit", filter] as const,
  auditEntry: (t: string, id: string) => [t, "audit", "entry", id] as const,
};

export interface AuditFilter {
  readonly actor?: string | undefined;
  readonly action?: string | undefined;
  readonly entity?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export function auditQueryString(filter: AuditFilter, cursor?: string | null): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (typeof v === "string" && v !== "") params.set(k, v);
  }
  if (cursor) params.set("cursor", cursor);
  const s = params.toString();
  return s === "" ? "" : `?${s}`;
}

export const useMyTenants = () =>
  useQuery({
    queryKey: keys.myTenants,
    queryFn: ({ signal }) =>
      api<{ tenants: MyTenant[] }>("GET", "/v1/tenancy/me/tenants", { signal }),
    staleTime: STALE.list,
  });

export const useProfile = (t: string) =>
  useQuery({
    queryKey: keys.profile(t),
    queryFn: ({ signal }) => api<Profile>("GET", "/v1/tenancy/business", { signal }),
    staleTime: STALE.reference,
  });

export const useBranches = (t: string) =>
  useQuery({
    queryKey: keys.branches(t),
    queryFn: ({ signal }) => api<{ branches: Branch[] }>("GET", "/v1/tenancy/branches", { signal }),
    staleTime: STALE.reference,
    select: (d) => d.branches,
  });

export const useLocations = (t: string, branchId: string | null) =>
  useQuery({
    queryKey: keys.locations(t, branchId ?? "none"),
    queryFn: ({ signal }) =>
      api<{ locations: Location[] }>("GET", `/v1/tenancy/branches/${branchId ?? ""}/locations`, {
        signal,
      }),
    enabled: branchId !== null,
    staleTime: STALE.reference,
    select: (d) => d.locations,
  });

export const useRoles = (t: string) =>
  useQuery({
    queryKey: keys.roles(t),
    queryFn: ({ signal }) => api<{ roles: Role[] }>("GET", "/v1/tenancy/roles", { signal }),
    staleTime: STALE.reference,
    select: (d) => d.roles,
  });

export const useMembers = (t: string) =>
  useInfiniteQuery({
    queryKey: keys.members(t),
    queryFn: ({ signal, pageParam }) =>
      api<{ members: Member[]; nextCursor: string | null }>(
        "GET",
        `/v1/tenancy/members?limit=50${pageParam ? `&cursor=${pageParam}` : ""}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.list,
  });

export const useInvites = (t: string) =>
  useQuery({
    queryKey: keys.invites(t),
    queryFn: ({ signal }) =>
      api<{ invites: Invite[]; nextCursor: string | null }>(
        "GET",
        "/v1/tenancy/invites?limit=100",
        { signal },
      ),
    staleTime: STALE.list,
    select: (d) => d.invites,
  });

export const useAudit = (t: string, filter: AuditFilter) =>
  useInfiniteQuery({
    queryKey: keys.audit(t, filter),
    queryFn: ({ signal, pageParam }) =>
      api<{ entries: AuditEntry[]; nextCursor: string | null }>(
        "GET",
        `/v1/audit/entries${auditQueryString(filter, pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.live,
  });

export const useAuditEntry = (t: string, id: string | null) =>
  useQuery({
    queryKey: keys.auditEntry(t, id ?? "none"),
    queryFn: ({ signal }) => api<AuditDetail>("GET", `/v1/audit/entries/${id ?? ""}`, { signal }),
    enabled: id !== null,
    staleTime: STALE.reference,
  });

export const useOnboarding = (t: string) =>
  useQuery({
    queryKey: keys.onboarding(t),
    queryFn: ({ signal }) =>
      api<{ onboardedAt: string | null; draft: OnboardingDraft | null }>(
        "GET",
        "/v1/tenancy/onboarding",
        {
          signal,
        },
      ),
    staleTime: STALE.live,
  });

/** Mutation that invalidates the given keys on success (the API is the source of truth). */
export function useApiMutation<I, O>(
  fn: (input: I) => Promise<O>,
  invalidate: readonly (readonly unknown[])[],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all(invalidate.map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
  });
}
