import { Text } from "@wise-biz/ui";
import { View } from "react-native";

import { Gate } from "../src/ui/gate.tsx";
import { useAppSelector } from "../src/ui/hooks.ts";
import { Screen } from "../src/ui/screen.tsx";

const COPY = {
  revoked:
    "The owner removed this terminal. Sales saved on it stay safe; ask the owner to export them.",
  suspended: "This terminal is paused. Ask the owner to resume it.",
  quarantined: "This terminal needs the owner to review it before it can sync again.",
  diverged: "This terminal's history no longer matches the server. Ask the owner to review it.",
} as const;

export default function Blocked() {
  const reason = useAppSelector((s) => s.session.blocked) ?? "suspended";
  return (
    <Gate phase="blocked">
      <Screen title="Terminal stopped">
        <View role="alert">
          <Text testID="blocked-reason">{COPY[reason]}</Text>
        </View>
      </Screen>
    </Gate>
  );
}
