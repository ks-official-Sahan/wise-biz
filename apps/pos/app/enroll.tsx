import { Button, TextField, Text } from "@wise-biz/ui";
import { useState } from "react";

import { useController } from "../src/ui/context.tsx";
import { friendlyError } from "../src/ui/errors.ts";
import { Gate } from "../src/ui/gate.tsx";
import { Screen } from "../src/ui/screen.tsx";

export default function Enroll() {
  const controller = useController();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = () => {
    const trimmed = code.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(undefined);
    controller.enroll(trimmed).catch((e: unknown) => {
      setError(friendlyError(e, "enroll"));
      setBusy(false);
    });
  };

  return (
    <Gate phase="unenrolled">
      <Screen
        title="Set up this terminal"
        subtitle="Enter the setup code from your owner console (Devices, Add terminal)."
      >
        <TextField
          label="Setup code"
          value={code}
          onChangeText={setCode}
          placeholder="XXXX-XXXX"
          autoCapitalize="characters"
          helper="The code works once and expires after a short time."
          {...(error === undefined ? {} : { error })}
          testID="enroll-code"
        />
        <Button
          label="Connect terminal"
          onPress={submit}
          loading={busy}
          disabled={code.trim() === ""}
          fullWidth
          testID="enroll-submit"
        />
        <Text variant="caption" tone="muted">
          Selling stays available offline once setup finishes.
        </Text>
      </Screen>
    </Gate>
  );
}
