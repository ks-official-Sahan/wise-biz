import { createStyles } from "@wise-biz/ui";
import { ScrollView } from "react-native";

import { ActionSections } from "./sections/ActionSections.tsx";
import { DataSections } from "./sections/DataSections.tsx";
import { InputSections } from "./sections/InputSections.tsx";
import { OverlaySections } from "./sections/OverlaySections.tsx";
import { TypographySections } from "./sections/TypographySections.tsx";

const useStyles = createStyles((t) => ({
  content: { paddingHorizontal: t.space[4], paddingBottom: t.space[8] },
}));

/** Every @wise-biz/ui component in its main states. Demo data only. */
export function ComponentsView() {
  const styles = useStyles();
  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <TypographySections />
      <ActionSections />
      <InputSections />
      <DataSections />
      <OverlaySections />
    </ScrollView>
  );
}
