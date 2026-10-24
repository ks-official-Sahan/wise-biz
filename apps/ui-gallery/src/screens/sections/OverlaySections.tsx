// Demo data: a cafe order and a voided line. Toasts are for background events only.
import { Button, Dialog, Sheet, Text, createStyles, useToast } from "@wise-biz/ui";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { Row } from "../../components/Row.tsx";
import { Section } from "../../components/Section.tsx";

import type { ToastTone } from "@wise-biz/ui";

const TONES: readonly { readonly tone: ToastTone; readonly message: string }[] = [
  { tone: "success", message: "Order 1042 saved" },
  { tone: "info", message: "Order 1043 queued for sync" },
  { tone: "warning", message: "Order 1044 held" },
  { tone: "danger", message: "Receipt 1041 did not print" },
];

const useStyles = createStyles((t) => ({
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: t.space[3] },
  sheetBody: { gap: t.space[3], paddingTop: t.space[3] },
}));

export function OverlaySections() {
  const styles = useStyles();
  const toast = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const openSheet = useCallback(() => {
    setSheetOpen(true);
  }, []);
  const closeSheet = useCallback(() => {
    setSheetOpen(false);
  }, []);
  const openDialog = useCallback(() => {
    setDialogOpen(true);
  }, []);
  const closeDialog = useCallback(() => {
    setDialogOpen(false);
  }, []);
  const voidLine = useCallback(() => {
    setDialogOpen(false);
    toast.show({ message: "Line voided", tone: "warning" });
  }, [toast]);

  return (
    <>
      <Section
        title="Sheet"
        purpose="Bottom sheet for a short task that keeps the sale in view. Escape or the scrim closes it."
      >
        <Row>
          <Button label="Add a note" variant="secondary" onPress={openSheet} />
        </Row>
        <Sheet visible={sheetOpen} title="Add a note to order" onClose={closeSheet}>
          <View style={styles.sheetBody}>
            <Text variant="body" tone="muted">
              Demo sheet. Notes print under the order on the kitchen ticket.
            </Text>
            <Row>
              <Button label="Save note" onPress={closeSheet} />
              <Button label="Cancel" variant="ghost" onPress={closeSheet} />
            </Row>
          </View>
        </Sheet>
      </Section>
      <Section title="Dialog" purpose="Confirms a destructive step. Cancel is the first action.">
        <Row>
          <Button label="Void line" variant="danger" onPress={openDialog} />
        </Row>
        <Dialog
          visible={dialogOpen}
          title="Void this line?"
          description="Ceylon milk tea, 2 cups, LKR 700.00 will be removed from the sale."
          onClose={closeDialog}
          actions={
            <View style={styles.actions}>
              <Button label="Keep line" variant="ghost" onPress={closeDialog} />
              <Button label="Void line" variant="danger" onPress={voidLine} />
            </View>
          }
        />
      </Section>
      <Section
        title="Toasts"
        purpose="Background events only. The message names the outcome, so it reads without color."
      >
        <Row>
          {TONES.map((item) => (
            <Button
              key={item.tone}
              label={`Show ${item.tone} toast`}
              variant="secondary"
              onPress={() => {
                toast.show({ message: item.message, tone: item.tone });
              }}
            />
          ))}
        </Row>
      </Section>
    </>
  );
}
