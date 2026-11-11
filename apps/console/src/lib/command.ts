"use client";

import { useRef, useState } from "react";

import { newId } from "./pricing.ts";
import { actionErrorText } from "./procurement.ts";

/**
 * One inline mutation: a fresh UUIDv7 per attempt goes to `run`, a second press while the first is in flight does
 * nothing, and a failure keeps its plain-words message for the screen to show.
 */
export function useCommand<A>(run: (arg: A, key: string) => Promise<unknown>, onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  async function submit(arg: A): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await run(arg, newId());
      onDone?.();
    } catch (err) {
      setError(actionErrorText(err, "Could not do this. Try again."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    submit,
    clearError: () => {
      setError(null);
    },
  };
}
