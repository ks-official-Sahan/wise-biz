import { useEffect, useState } from "react";
import { Animated, Easing, Platform } from "react-native";

import { useReducedMotion } from "../theme/useReducedMotion.ts";

import type { NativeTheme } from "@wise-biz/theme";

export type BezierCurve = readonly [number, number, number, number];

export interface OverlayTransition {
  /** Keep the Modal mounted until the exit animation ends. */
  readonly mounted: boolean;
  /** 0 when hidden, 1 when shown. Drive opacity and transforms from it. */
  readonly progress: Animated.Value;
  readonly reduced: boolean;
}

/** Enter with motion.enter, exit with motion.exit (faster), both on the given curve. */
export function useOverlayTransition(
  visible: boolean,
  motion: NativeTheme["motion"],
  curve: BezierCurve,
): OverlayTransition {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(0));
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    const config = {
      useNativeDriver: Platform.OS !== "web",
      easing: Easing.bezier(...curve),
    };
    if (visible) {
      setMounted(true);
      const enter = Animated.timing(progress, {
        ...config,
        toValue: 1,
        duration: reduced ? 0 : motion.enter,
      });
      enter.start();
      return () => {
        enter.stop();
      };
    }
    const exit = Animated.timing(progress, {
      ...config,
      toValue: 0,
      duration: reduced ? 0 : motion.exit,
    });
    exit.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => {
      exit.stop();
    };
  }, [visible, progress, reduced, motion, curve]);

  return { mounted, progress, reduced };
}
