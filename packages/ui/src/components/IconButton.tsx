import { Animated, Pressable, StyleSheet } from "react-native";

import { FOCUSABLE_WHEN_DISABLED } from "../a11y/web.ts";
import { usePressFeedback } from "../motion/usePressFeedback.ts";
import { createStyles } from "../theme/createStyles.ts";
import { focusRingStyle } from "../theme/focus.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import { Icon } from "./Icon.tsx";

import type { PressableState } from "../a11y/web.ts";
import type { Icon as TablerIcon } from "@tabler/icons-react-native";
import type { NativeTheme } from "@wise-biz/theme";

export interface IconButtonProps {
  readonly icon: TablerIcon;
  /** Required: an icon has no visible text. */
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly variant?: "ghost" | "secondary";
  readonly disabled?: boolean;
  /** Scale on press. Keyboard-like keys turn this off and use a background change only. */
  readonly pressMotion?: boolean;
  readonly testID?: string;
}

const useIconButtonStyles = createStyles((t) => ({
  base: {
    minWidth: t.target.min,
    minHeight: t.target.min,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: t.radius.control,
  },
}));

function iconPalette(
  theme: NativeTheme,
  variant: "ghost" | "secondary",
  inactive: boolean,
  lifted: boolean,
): { background: string; border: string; glyph: string } {
  if (inactive) {
    return {
      background: theme.color.surfaceSunken,
      border: theme.color.border,
      glyph: theme.color.textMuted,
    };
  }
  const tokens = theme.component.button[variant];
  return {
    background: lifted ? tokens.bgPressed : tokens.bg,
    border: tokens.border,
    glyph: variant === "ghost" ? theme.color.accentText : theme.color.text,
  };
}

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  variant = "ghost",
  disabled = false,
  pressMotion = true,
  testID,
}: IconButtonProps) {
  const theme = useTheme();
  const styles = useIconButtonStyles();
  const press = usePressFeedback();
  const motionOn = pressMotion && !disabled;

  const resolve = (state: PressableState): ReturnType<typeof iconPalette> =>
    iconPalette(theme, variant, disabled, state.pressed || state.hovered === true);

  return (
    <Animated.View style={press.style}>
      <Pressable
        role="button"
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        {...FOCUSABLE_WHEN_DISABLED}
        onPress={disabled ? undefined : onPress}
        onPressIn={motionOn ? press.onPressIn : undefined}
        onPressOut={motionOn ? press.onPressOut : undefined}
        testID={testID}
        style={(state: PressableState) => {
          const palette = resolve(state);
          return [
            styles.base,
            { backgroundColor: palette.background, borderColor: palette.border },
            focusRingStyle(theme, state.focused),
          ];
        }}
      >
        {(state: PressableState) => <Icon icon={icon} color={resolve(state).glyph} />}
      </Pressable>
    </Animated.View>
  );
}
