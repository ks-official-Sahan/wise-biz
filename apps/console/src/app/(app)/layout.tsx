"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { Button, ErrorState, SkeletonRows, cx } from "@/components/ui.tsx";
import { api } from "@/lib/api.ts";
import { NAV } from "@/lib/nav.ts";
import { keys, useMyTenants } from "@/lib/queries.ts";
import { useSession, useSignOut } from "@/lib/session.ts";
import { TenantProvider } from "@/lib/tenant.tsx";

import { CommandPalette } from "./command-palette.tsx";
import s from "./shell.module.css";

import type { ReactNode } from "react";

/**
 * Signed-in frame. Guards in order: session (else sign-in), at least one business (else setup), an active business
 * on the session (else switch to the first), onboarding finished (else the wizard).
 */
export default function AppLayout({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const signOut = useSignOut();
  const signedIn = session.data !== null;
  const tenants = useMyTenants();
  const activeId = session.data?.session.activeTenantId ?? null;
  const list = useMemo(() => tenants.data?.tenants ?? [], [tenants.data]);
  const active = list.find((t) => t.tenantId === activeId) ?? null;

  const qc = useQueryClient();
  const autoSwitching = useRef(false);
  /** Activates a business on the session and drops every cached query of the previous one. */
  const switchTenant = useCallback(
    async (tenantId: string): Promise<void> => {
      await api("POST", "/v1/tenancy/switch", { body: { tenantId } });
      if (activeId !== null) qc.removeQueries({ queryKey: keys.tenant(activeId) });
      await qc.invalidateQueries({ queryKey: keys.me });
      await session.refetch();
    },
    [qc, activeId, session],
  );

  useEffect(() => {
    if (session.isPending) return;
    if (!signedIn) {
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}` as never);
      return;
    }
    if (tenants.isPending || tenants.isError) return;
    if (list.length === 0) {
      router.replace("/setup");
      return;
    }
    if (active === null) {
      const first = list[0];
      if (first !== undefined && !autoSwitching.current) {
        autoSwitching.current = true;
        void switchTenant(first.tenantId).catch(() => {
          autoSwitching.current = false;
        });
      }
      return;
    }
    if (active.onboardedAt === null && pathname !== "/onboarding") {
      router.replace("/onboarding");
    }
  }, [
    session,
    signedIn,
    tenants.isPending,
    tenants.isError,
    list,
    active,
    pathname,
    router,
    switchTenant,
  ]);

  if (tenants.isError) {
    return (
      <main className={s.main}>
        <ErrorState error={tenants.error} onRetry={() => void tenants.refetch()} />
      </main>
    );
  }
  if (session.isPending || !signedIn || tenants.isPending || active === null) {
    return (
      <main className={s.main}>
        <SkeletonRows label="Loading your business" rows={6} />
      </main>
    );
  }

  const userId = session.data?.user.id ?? "";

  return (
    <TenantProvider tenant={active} tenants={list} userId={userId}>
      <div className={s.shell}>
        <nav className={s.side} aria-label="Main">
          <div className={s.brand}>
            <span aria-hidden className={s.mark} />
            wise-biz
          </div>
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              prefetch
              className={s.link}
              aria-current={pathname === n.href ? "page" : undefined}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <header className={s.top}>
          <label className="sr-only" htmlFor="tenant-switcher">
            Business
          </label>
          <select
            id="tenant-switcher"
            className={s.switcher}
            value={active.tenantId}
            onChange={(e) => {
              void switchTenant(e.target.value).then(() => {
                router.refresh();
              });
            }}
          >
            {list.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.name}
              </option>
            ))}
          </select>
          <span className={s.grow} />
          <span className={cx(s.kbd, s.hideSmall)} aria-hidden>
            Ctrl K
          </span>
          <Button
            variant="ghost"
            onClick={() => {
              void signOut().then(() => {
                router.replace("/sign-in");
              });
            }}
          >
            Sign out
          </Button>
        </header>
        <main id="main" className={s.main}>
          {children}
        </main>
        <nav className={s.bottom} aria-label="Main (compact)">
          {NAV.filter((n) => n.primary).map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={s.link}
              aria-current={pathname === n.href ? "page" : undefined}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <CommandPalette />
      </div>
    </TenantProvider>
  );
}
