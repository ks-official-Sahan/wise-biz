import { View } from "react-native";

import { useTheme } from "../theme/ThemeProvider.tsx";

import type { Icon as TablerIcon } from "@tabler/icons-react-native";

/** One icon set (Tabler) at stroke 1.75 across the app. */
export const ICON_STROKE_WIDTH = 1.75;

export interface IconProps {
  readonly icon: TablerIcon;
  /** dp. Defaults to space[6] (20). */
  readonly size?: number;
  /** Defaults to the text color. */
  readonly color?: string;
  /** Set when the icon carries meaning on its own. Otherwise it is hidden from assistive tech. */
  readonly accessibilityLabel?: string;
}

export function Icon({ icon: Glyph, size, color, accessibilityLabel }: IconProps) {
  const theme = useTheme();
  const glyph = (
    <Glyph
      size={size ?? theme.space[6]}
      color={color ?? theme.color.text}
      strokeWidth={ICON_STROKE_WIDTH}
    />
  );
  if (accessibilityLabel === undefined) return <View aria-hidden>{glyph}</View>;
  return (
    <View role="img" accessibilityLabel={accessibilityLabel}>
      {glyph}
    </View>
  );
}
