import { Button, Text, useToast } from "@wise-biz/ui";

import { reportError } from "../src/runtime/report.ts";
import { SyncChip } from "../src/ui/chrome.tsx";
import { useController } from "../src/ui/context.tsx";
import { Gate } from "../src/ui/gate.tsx";
import { useAppSelector } from "../src/ui/hooks.ts";
import { Screen } from "../src/ui/screen.tsx";

/** Home after unlock. The sell screen (P1-09) replaces the body; the chrome and the sign-out guard stay. */
export default function Home() {
  const controller = useController();
  const toast = useToast();
  const device = useAppSelector((s) => s.session.device);

  const signOut = () => {
    controller.signOut().catch((e: unknown) => {
      reportError(e);
      toast.show({
        tone: "danger",
        message: "Sales are still waiting to sync. Connect to the network and try again.",
      });
    });
  };

  return (
    <Gate phase="unlocked">
      <Screen
        title="Ready to sell"
        {...(device?.name ? { subtitle: `Terminal: ${device.name}` } : {})}
      >
        <SyncChip />
        <Text tone="muted">The sell screen arrives in the next step.</Text>
        <Button
          label="Lock"
          variant="secondary"
          onPress={() => {
            controller.lock().catch(() => undefined);
          }}
          fullWidth
          testID="lock"
        />
        <Button
          label="Sign out terminal"
          variant="ghost"
          onPress={signOut}
          fullWidth
          testID="sign-out"
        />
      </Screen>
    </Gate>
  );
}
