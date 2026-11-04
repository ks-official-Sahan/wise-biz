import { Text, createStyles } from "@wise-biz/ui";
import { ScrollView, View } from "react-native";

import { OfflineBanner } from "./chrome.tsx";

import type { ReactNode } from "react";

const useStyles = createStyles((t) => ({
  root: { flex: 1, backgroundColor: t.color.surface },
  scroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: t.space[6] },
  panel: { width: "100%", maxWidth: 440, gap: t.space[4] },
}));

/** Centered single-column shell for the pre-sale screens (enroll, first sync, PIN, blocked). */
export function Screen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.root}>
      <OfflineBanner />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.panel}>
          <Text variant="display" headingLevel={1}>
            {title}
          </Text>
          {subtitle === undefined ? null : <Text tone="muted">{subtitle}</Text>}
          {children}
        </View>
      </ScrollView>
    </View>
  );
}
