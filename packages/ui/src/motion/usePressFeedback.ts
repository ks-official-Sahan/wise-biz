import { useCallback, useEffect, useMemo, useState } from "react";
import { Animated, Easing, Platform } from "react-native";

import { useTheme } from "../theme/ThemeProvider.tsx";
import { useReducedMotion } from "../theme/useReducedMotion.ts";

/** Press feedback scale from the UI principles (0.97). */
export const PRESS_SCALE = 0.97;

export interface PressFeedback {
  /** Apply to an Animated.View that wraps the Pressable. */
  readonly style: Animated.WithAnimatedValue<{ transform: [{ scale: Animated.Value }] }>;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
}

/**
 * Scale-down press feedback on the transform channel only. Skipped under reduced motion.
 * The native driver is used everywhere except web, where react-native-web runs the animation itself.
 */
export function usePressFeedback(): PressFeedback {
  const { motion } = useTheme();
  const reduced = useReducedMotion();
  const [scale] = useState(() => new Animated.Value(1));

  useEffect(
    () => () => {
      scale.stopAnimation();
    },
    [scale],
  );

  const animate = useCallback(
    (to: number) => {
      if (reduced) return;
      Animated.timing(scale, {
        toValue: to,
        duration: motion.press,
        easing: Easing.bezier(...motion.easeOut),
        useNativeDriver: Platform.OS !== "web",
      }).start();
    },
    [reduced, scale, motion],
  );

  return useMemo(
    () => ({
      style: { transform: [{ scale }] },
      onPressIn: () => {
        animate(PRESS_SCALE);
      },
      onPressOut: () => {
        animate(1);
      },
    }),
    [animate, scale],
  );
}
