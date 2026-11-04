import { Text, createStyles } from "@wise-biz/ui";
import { useId } from "react";
import { StyleSheet, View } from "react-native";

import type { ReactNode } from "react";

const useSectionStyles = createStyles((t) => ({
  section: {
    gap: t.space[3],
    paddingVertical: t.space[5],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: t.color.border,
  },
  header: { gap: t.space[1] },
  body: { gap: t.space[3] },
}));

/** One gallery section: heading, a one-line purpose, then the states. */
export function Section({
  title,
  purpose,
  children,
}: {
  readonly title: string;
  readonly purpose: string;
  readonly children: ReactNode;
}) {
  const styles = useSectionStyles();
  const headingId = useId();
  return (
    <View role="region" aria-labelledby={headingId} style={styles.section}>
      <View style={styles.header}>
        <Text nativeID={headingId} variant="heading" headingLevel={2}>
          {title}
        </Text>
        <Text variant="caption" tone="muted">
          {purpose}
        </Text>
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}
