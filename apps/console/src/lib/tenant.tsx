"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo } from "react";

import { api } from "./api.ts";
import { keys } from "./queries.ts";

import type { MyTenant } from "./types.ts";
import type { ReactNode } from "react";

export interface TenantContextValue {
  readonly tenant: MyTenant;
  readonly tenants: readonly MyTenant[];
  readonly userId: string;
  readonly switchTo: (tenantId: string) => Promise<void>;
}

const TenantContext = createContext<TenantContextValue | null>(null);

export function TenantProvider({
  tenant,
  tenants,
  userId,
  children,
}: {
  readonly tenant: MyTenant;
  readonly tenants: readonly MyTenant[];
  readonly userId: string;
  readonly children: ReactNode;
}) {
  const qc = useQueryClient();
  const switchTo = useCallback(
    async (tenantId: string): Promise<void> => {
      await api("POST", "/v1/tenancy/switch", { body: { tenantId } });
      // Keys are tenant-prefixed, so nothing of the old tenant can show; drop it to free memory and refetch session.
      qc.removeQueries({ queryKey: keys.tenant(tenant.tenantId) });
      await qc.invalidateQueries({ queryKey: keys.me });
    },
    [qc, tenant.tenantId],
  );
  const value = useMemo(
    () => ({ tenant, tenants, userId, switchTo }),
    [tenant, tenants, userId, switchTo],
  );
  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantContextValue {
  const v = useContext(TenantContext);
  if (v === null) throw new Error("useTenant must be used inside <TenantProvider>.");
  return v;
}
