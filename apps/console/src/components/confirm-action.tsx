"use client";

import { useRef, useState } from "react";

import { newId } from "@/lib/pricing.ts";
import { actionErrorText } from "@/lib/procurement.ts";

import { Alert, Button, Dialog, Row, Stack } from "./ui.tsx";

import type { ReactNode } from "react";

/**
 * A confirmation before an action that cannot be taken back (send, cancel, close, archive). `run` receives one
 * idempotency key per open dialog, so a retry after a lost response replays instead of applying twice.
 */
export function ConfirmAction({
  title,
  confirmLabel,
  danger = false,
  run,
  onClose,
  children,
}: {
  readonly title: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly run: (idempotencyKey: string) => Promise<unknown>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => newId());
  const inFlight = useRef(false);

  async function go(): Promise<void> {
    // A second press while the first is in flight does nothing (the button is also busy).
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await run(key);
      onClose();
    } catch (err) {
      setError(actionErrorText(err, "Could not do this. Try again."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open title={title} onClose={onClose}>
      <Stack>
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        {children}
        <Row spread>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Keep it as it is
          </Button>
          <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={() => void go()}>
            {confirmLabel}
          </Button>
        </Row>
      </Stack>
    </Dialog>
  );
}
