import { Redirect } from "expo-router";

import { useAppSelector } from "./hooks.ts";

import type { Phase } from "../state/slices.ts";
import type { ReactNode } from "react";

/** The route each phase belongs to. Every screen renders through `Gate`, so a deep link can never skip a step. */
export const ROUTE_FOR_PHASE: Record<Phase, string> = {
  booting: "/",
  unenrolled: "/enroll",
  enrolled: "/bootstrap",
  locked: "/pin",
  unlocked: "/home",
  blocked: "/blocked",
};

export function Gate({ phase, children }: { phase: Phase; children: ReactNode }) {
  const current = useAppSelector((s) => s.session.phase);
  if (current !== phase) return <Redirect href={ROUTE_FOR_PHASE[current]} />;
  return <>{children}</>;
}
