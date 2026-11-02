import { Button, NumberPad, Sheet, Text, TextField, createStyles } from "@wise-biz/ui";
import { useState } from "react";
import { View } from "react-native";

import { requestApproval } from "./port.ts";

import type { OverridePort, OverrideRequest } from "./port.ts";
import type { Approval } from "../../state/slices.ts";

const useStyles = createStyles((t) => ({ body: { gap: t.space[3], padding: t.space[4] } }));

const MESSAGE = {
  invalid: "That PIN did not work. Try again.",
  self: "A supervisor other than you must approve this.",
  unavailable:
    "Supervisor approval is not available on this terminal yet. Ask a manager to make the change.",
  no_reason: "Add a short reason.",
} as const;

export interface OverrideSheetProps {
  readonly visible: boolean;
  readonly title: string;
  readonly request: OverrideRequest | undefined;
  readonly port: OverridePort;
  readonly newId: () => string;
  readonly now: () => number;
  readonly onApproved: (approval: Approval) => void;
  readonly onCancel: () => void;
}

/** Supervisor PIN sheet: who approves, why, and their PIN. Nothing is stored except the approval record. */
export function OverrideSheet(p: OverrideSheetProps) {
  const s = useStyles();
  const [approver, setApprover] = useState("");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const close = () => {
    setPin("");
    setError(undefined);
    p.onCancel();
  };

  const submit = () => {
    if (p.request === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    requestApproval(
      p.port,
      { ...p.request, approverUserId: approver.trim(), pin, reason },
      p.newId,
      p.now,
    )
      .then((r) => {
        setPin("");
        if (r.ok) {
          setReason("");
          p.onApproved(r.approval);
        } else {
          setError(MESSAGE[r.reason]);
        }
      })
      .catch(() => {
        setError(MESSAGE.unavailable);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Sheet visible={p.visible} title={p.title} onClose={close} testID="override-sheet">
      <View style={s.body}>
        <Text tone="muted">A supervisor must approve this change.</Text>
        <TextField
          label="Supervisor ID"
          value={approver}
          onChangeText={setApprover}
          testID="override-approver"
        />
        <TextField
          label="Reason"
          value={reason}
          onChangeText={setReason}
          testID="override-reason"
        />
        <View role="img" aria-label={`${String(pin.length)} of 6 digits entered`}>
          <Text variant="title" testID="override-dots">
            {"●".repeat(pin.length) + "○".repeat(Math.max(0, 6 - pin.length))}
          </Text>
        </View>
        {error === undefined ? null : (
          <View role="alert">
            <Text tone="danger" testID="override-error">
              {error}
            </Text>
          </View>
        )}
        <NumberPad
          onKey={(k) => {
            if (k === "delete") setPin((x) => x.slice(0, -1));
            else if (/^\d$/.test(k) && pin.length < 6) setPin((x) => x + k);
          }}
          onSubmit={submit}
        />
        <Button
          label="Approve"
          onPress={submit}
          loading={busy}
          disabled={pin.length < 4 || approver.trim() === ""}
          fullWidth
          testID="override-submit"
        />
        <Button label="Cancel" variant="ghost" onPress={close} fullWidth />
      </View>
    </Sheet>
  );
}
