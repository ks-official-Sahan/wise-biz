import { Animated, Pressable, StyleSheet, View } from "react-native";

import { usePressFeedback } from "../motion/usePressFeedback.ts";
import { createStyles } from "../theme/createStyles.ts";
import { focusRingStyle } from "../theme/focus.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import type { PressableState } from "../a11y/web.ts";
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

interface CardBase {
  readonly children?: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

/** A static card, or a pressable one. A pressable card must name itself for assistive tech. */
export type CardProps =
  | (CardBase & { readonly onPress?: undefined; readonly accessibilityLabel?: undefined })
  | (CardBase & { readonly onPress: () => void; readonly accessibilityLabel: string });

const useCardStyles = createStyles((t) => ({
  base: {
    backgroundColor: t.color.surfaceRaised,
    borderColor: t.color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: t.radius.card,
    padding: t.space[4],
  },
  stretch: { alignSelf: "stretch" },
}));

export function Card(props: CardProps) {
  const { children, style, testID } = props;
  const theme = useTheme();
  const styles = useCardStyles();
  const press = usePressFeedback();
  const { onPress, accessibilityLabel } = props;

  if (onPress === undefined) {
    return (
      <View testID={testID} style={[styles.base, style]}>
        {children}
      </View>
    );
  }

  return (
    <Animated.View style={[styles.stretch, press.style]}>
      <Pressable
        role="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        testID={testID}
        style={(state: PressableState) => [
          styles.base,
          state.pressed || state.hovered === true
            ? { backgroundColor: theme.color.surfaceSunken }
            : undefined,
          focusRingStyle(theme, state.focused),
          style,
        ]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}
