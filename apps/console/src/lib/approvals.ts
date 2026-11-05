import { useDevices } from "./devices.ts";
import { useSales } from "./sales.ts";

import type { Device } from "./devices.ts";
import type { Sale } from "./sales.ts";

/** Page size of the sales list the inbox reads; more than this is shown as "50+" rather than counted. */
const SALES_PAGE = 50;

/** Terminals that enrolled and wait for someone to let them in. */
export const pendingDevices = (devices: readonly Device[]): Device[] =>
  devices.filter((d) => d.status === "pending");

/** The number on the nav badge and the page title: "" when nothing waits, "50+" when the sales list is cut. */
export function countLabel(
  pendingTerminals: number,
  flaggedSales: number,
  moreSales: boolean,
): string {
  const total = pendingTerminals + flaggedSales;
  if (total === 0) return "";
  return moreSales || flaggedSales >= SALES_PAGE ? `${String(total)}+` : String(total);
}

/**
 * The inbox reads what other modules already own, through their own endpoints and permissions (ADR 0021): sales a
 * terminal flagged for review (`sales:read`) and terminals waiting for approval (`devices:read`). A section the person
 * may not read comes back as an error and is left out of the count.
 */
export function useApprovals(t: string) {
  const sales = useSales(t, { flagged: true });
  const devices = useDevices(t);
  const flagged: Sale[] = sales.data?.pages[0]?.items ?? [];
  const waiting = pendingDevices(devices.data ?? []);
  return {
    sales,
    devices,
    flagged,
    waiting,
    label: countLabel(
      waiting.length,
      flagged.length,
      sales.data?.pages[0]?.nextCursor !== null && sales.data?.pages[0]?.nextCursor !== undefined,
    ),
  };
}
