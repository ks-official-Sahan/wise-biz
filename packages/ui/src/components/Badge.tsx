import { View } from "react-native";

import { useTheme } from "../theme/ThemeProvider.tsx";

import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

import type { Icon as TablerIcon } from "@tabler/icons-react-native";
import type { ComponentTokens } from "@wise-biz/theme";

export type BadgeTone = keyof ComponentTokens["badge"];

export interface BadgeProps {
  readonly tone: BadgeTone;
  readonly label: string;
  readonly icon?: TablerIcon;
}

/** Status chip. The label is always visible, so status is never conveyed by color alone. */
export function Badge({ tone, label, icon }: BadgeProps) {
  const { component, space, radius, fontSize } = useTheme();
  const colors = component.badge[tone];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: space[2],
        paddingHorizontal: space[3],
        paddingVertical: space[1],
        borderRadius: radius.pill,
        backgroundColor: colors.bg,
      }}
    >
      {icon === undefined ? null : <Icon icon={icon} size={fontSize.sm} color={colors.fg} />}
      <Text variant="label" style={{ color: colors.fg }}>
        {label}
      </Text>
    </View>
  );
}
