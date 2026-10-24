import { View } from "react-native";

import { useTheme } from "../theme/ThemeProvider.tsx";

import { Text } from "./Text.tsx";

export type StatusTone = "danger" | "warning" | "success" | "info";

export interface StatusDotProps {
  readonly tone: StatusTone;
  /** Visible and announced. Carries the meaning; the dot is decoration on top of it. */
  readonly label: string;
}

/** Semantic state indicator: a dot plus a visible, announced label. */
export function StatusDot({ tone, label }: StatusDotProps) {
  const { color, space, radius } = useTheme();
  const fill = {
    danger: color.danger,
    warning: color.warning,
    success: color.success,
    info: color.info,
  }[tone];
  return (
    <View role="status" style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
      <View
        aria-hidden
        style={{
          width: space[3],
          height: space[3],
          borderRadius: radius.pill,
          backgroundColor: fill,
        }}
      />
      <Text variant="label">{label}</Text>
    </View>
  );
}
