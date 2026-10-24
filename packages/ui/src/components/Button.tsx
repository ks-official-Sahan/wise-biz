import { useCallback, useRef } from "react";
import { ActivityIndicator, Animated, Pressable, StyleSheet } from "react-native";

import { FOCUSABLE_WHEN_DISABLED } from "../a11y/web.ts";
import { usePressFeedback } from "../motion/usePressFeedback.ts";
import { createStyles } from "../theme/createStyles.ts";
import { focusRingStyle } from "../theme/focus.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { FONT_WEIGHT, lineHeightFor } from "../theme/typography.ts";

import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

import type { PressableState } from "../a11y/web.ts";
import type { Icon as TablerIcon } from "@tabler/icons-react-native";
import type { NativeTheme } from "@wise-biz/theme";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "lg";

export interface ButtonProps {
  /** Visible text. Verb plus object ("Pay LKR 1,403.00"). It is also the accessible name. */
  readonly label: string;
  /** Returning a promise blocks further presses until it settles (double-submit guard). */
  readonly onPress: () => unknown;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly icon?: TablerIcon;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  readonly fullWidth?: boolean;
  readonly testID?: string;
}

const useButtonStyles = createStyles((t) => {
  const { fontSize, lineHeight, fontFamily } = t;
  return {
    inline: { alignSelf: "flex-start" },
    stretch: { alignSelf: "stretch" },
    base: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: t.space[2],
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: t.radius.control,
      paddingHorizontal: t.space[5],
    },
    md: { minHeight: Math.max(t.control.control, t.target.min) },
    lg: { minHeight: Math.max(t.control.key, t.target.min) },
    labelMd: {
      fontFamily: fontFamily.body,
      fontSize: fontSize.md,
      lineHeight: lineHeightFor(fontSize.md, lineHeight.body),
      fontWeight: FONT_WEIGHT.medium,
    },
    labelLg: {
      fontFamily: fontFamily.body,
      fontSize: fontSize.lg,
      lineHeight: lineHeightFor(fontSize.lg, lineHeight.body),
      fontWeight: FONT_WEIGHT.medium,
    },
  };
});

interface Palette {
  readonly background: string;
  readonly border: string;
  readonly label: string;
}

/** Colors for one visual state. Disabled keeps 3:1 or better on the label, without opacity. */
function buttonPalette(
  theme: NativeTheme,
  variant: ButtonVariant,
  inactive: boolean,
  lifted: boolean,
): Palette {
  if (inactive) {
    return {
      background: theme.color.surfaceSunken,
      border: theme.color.border,
      label: theme.color.textMuted,
    };
  }
  const tokens = theme.component.button[variant];
  return {
    background: lifted ? tokens.bgPressed : tokens.bg,
    border: tokens.border,
    label: tokens.fg,
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export function Button({
  label,
  onPress,
  variant = "primary",
  size = "md",
  icon,
  loading = false,
  disabled = false,
  fullWidth = false,
  testID,
}: ButtonProps) {
  const theme = useTheme();
  const styles = useButtonStyles();
  const press = usePressFeedback();
  const inFlight = useRef(false);
  const inactive = disabled || loading;

  const handlePress = useCallback(() => {
    if (inactive || inFlight.current) return;
    const result: unknown = onPress();
    if (!isPromiseLike(result)) return;
    inFlight.current = true;
    const release = (): void => {
      inFlight.current = false;
    };
    void result.then(release, release);
  }, [inactive, onPress]);

  const resolve = (state: PressableState): Palette =>
    buttonPalette(theme, variant, inactive, state.pressed || state.hovered === true);

  return (
    <Animated.View style={[fullWidth ? styles.stretch : styles.inline, press.style]}>
      <Pressable
        role="button"
        disabled={inactive}
        {...FOCUSABLE_WHEN_DISABLED}
        aria-busy={loading}
        onPress={handlePress}
        onPressIn={inactive ? undefined : press.onPressIn}
        onPressOut={inactive ? undefined : press.onPressOut}
        testID={testID}
        style={(state: PressableState) => {
          const palette = resolve(state);
          return [
            styles.base,
            styles[size],
            { backgroundColor: palette.background, borderColor: palette.border },
            focusRingStyle(theme, state.focused),
          ];
        }}
      >
        {(state: PressableState) => {
          const palette = resolve(state);
          return (
            <>
              {loading ? (
                <ActivityIndicator color={palette.label} />
              ) : icon === undefined ? null : (
                <Icon icon={icon} color={palette.label} />
              )}
              <Text
                variant="body"
                style={[size === "lg" ? styles.labelLg : styles.labelMd, { color: palette.label }]}
              >
                {label}
              </Text>
            </>
          );
        }}
      </Pressable>
    </Animated.View>
  );
}
