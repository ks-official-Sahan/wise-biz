import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";

import { useController } from "./context.tsx";

import type { PosDispatch, RootState } from "../state/store.ts";
import type { SyncHealth } from "@wise-biz/sync";

export const useAppDispatch = useDispatch.withTypes<PosDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();

/** True while the browser (or the OS) says there is no network. Sync keeps working offline; this only informs. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const target = globalThis as unknown as {
      navigator?: { onLine?: boolean };
      addEventListener?: (t: string, f: () => void) => void;
      removeEventListener?: (t: string, f: () => void) => void;
    };
    const read = () => {
      setOnline(target.navigator?.onLine !== false);
    };
    read();
    target.addEventListener?.("online", read);
    target.addEventListener?.("offline", read);
    return () => {
      target.removeEventListener?.("online", read);
      target.removeEventListener?.("offline", read);
    };
  }, []);
  return online;
}

/** Sync health, refreshed every few seconds (it is a local read: the outbox count and the push state). */
export function useSyncHealth(intervalMs = 3000): SyncHealth | undefined {
  const controller = useController();
  const [health, setHealth] = useState<SyncHealth>();
  useEffect(() => {
    let alive = true;
    const tick = () => {
      controller
        .health()
        .then((h) => {
          if (alive) setHealth(h);
        })
        .catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [controller, intervalMs]);
  return health;
}
