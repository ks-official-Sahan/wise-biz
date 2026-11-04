import { Button, Chip, NumberPad, Text, TextField } from "@wise-biz/ui";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { useController } from "../src/ui/context.tsx";
import { friendlyError } from "../src/ui/errors.ts";
import { Gate } from "../src/ui/gate.tsx";
import { Screen } from "../src/ui/screen.tsx";

import type { Operator } from "../src/runtime/controller.ts";

const PIN_LENGTH = 6;

/** PIN unlock. Operators come from the synced roster; until one exists the user id is typed. */
export default function Pin() {
  const controller = useController();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [userId, setUserId] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    controller
      .operators()
      .then(setOperators)
      .catch(() => undefined);
  }, [controller]);

  const submit = (value: string) => {
    if (busy || userId === "" || value.length < 4) return;
    setBusy(true);
    setError(undefined);
    controller.unlock(userId, value).catch((e: unknown) => {
      setError(friendlyError(e, "pin"));
      setPin("");
      setBusy(false);
    });
  };

  const onKey = (key: string) => {
    if (busy) return;
    if (key === "delete") setPin((p) => p.slice(0, -1));
    else if (/^\d+$/.test(key) && pin.length < PIN_LENGTH)
      setPin((p) => (p + key).slice(0, PIN_LENGTH));
  };

  return (
    <Gate phase="locked">
      <Screen title="Unlock" subtitle="Choose who is selling and enter the PIN.">
        {operators.length > 0 ? (
          operators.map((o) => (
            <Chip
              key={o.userId}
              kind="radio"
              label={o.name}
              selected={o.userId === userId}
              onPress={() => {
                setUserId(o.userId);
              }}
            />
          ))
        ) : (
          <TextField label="User ID" value={userId} onChangeText={setUserId} testID="pin-user" />
        )}
        <View role="img" aria-label={`${String(pin.length)} digits entered`} testID="pin-dots">
          <Text variant="title" numeric>
            {"●".repeat(pin.length) + "○".repeat(Math.max(0, PIN_LENGTH - pin.length))}
          </Text>
        </View>
        {error === undefined ? null : (
          <View role="alert">
            <Text tone="danger" testID="pin-error">
              {error}
            </Text>
          </View>
        )}
        <NumberPad
          onKey={onKey}
          onSubmit={() => {
            submit(pin);
          }}
          testID="pin-pad"
        />
        <Button
          label="Unlock"
          onPress={() => {
            submit(pin);
          }}
          loading={busy}
          disabled={userId === "" || pin.length < 4}
          fullWidth
          testID="pin-submit"
        />
      </Screen>
    </Gate>
  );
}
