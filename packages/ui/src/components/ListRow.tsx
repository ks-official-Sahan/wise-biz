import { Pressable, StyleSheet, View } from "react-native";

import { createStyles } from "../theme/createStyles.ts";
import { focusRingStyle } from "../theme/focus.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import { Text } from "./Text.tsx";

import type { PressableState } from "../a11y/web.ts";
import type { ReactNode } from "react";

export interface ListRowProps {
  /** Visible text. It is also the accessible name of a pressable row. */
  readonly title: string;
  readonly subtitle?: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onPress?: () => void;
  readonly divider?: boolean;
  readonly testID?: string;
}

const useRowStyles = createStyles((t) => ({
  base: {
    minHeight: t.target.min,
    flexDirection: "row",
    alignItems: "center",
    gap: t.space[3],
    paddingVertical: t.space[3],
    paddingHorizontal: t.space[4],
  },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.color.border },
  body: { flex: 1, gap: t.space[1] },
}));

/** Row with optional leading and trailing slots. Min height is the touch target. */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  divider = false,
  testID,
}: ListRowProps) {
  const theme = useTheme();
  const styles = useRowStyles();
  const content = (
    <>
      {leading}
      <View style={styles.body}>
        <Text variant="body">{title}</Text>
        {subtitle === undefined ? null : (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        )}
      </View>
      {trailing}
    </>
  );

  if (onPress === undefined) {
    return (
      <View testID={testID} style={[styles.base, divider ? styles.divider : undefined]}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      role="button"
      onPress={onPress}
      testID={testID}
      style={(state: PressableState) => [
        styles.base,
        divider ? styles.divider : undefined,
        state.pressed || state.hovered === true
          ? { backgroundColor: theme.color.surfaceSunken }
          : undefined,
        focusRingStyle(theme, state.focused),
      ]}
    >
      {content}
    </Pressable>
  );
}
