import { useEffect, useState } from "react";
import { Animated, Platform, type DimensionValue } from "react-native";

import { createStyles } from "../theme/createStyles.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { useReducedMotion } from "../theme/useReducedMotion.ts";

/** Full pulse cycle (1.2 s). Not a theme token: it is a loading-state rhythm, not a motion token. */
const PULSE_MS = 1200;
const PULSE_LOW = 0.5;

export type SkeletonRadius = "control" | "card" | "pill";

export interface SkeletonProps {
  readonly width: DimensionValue;
  readonly height: DimensionValue;
  readonly radius?: SkeletonRadius;
}

const useSkeletonStyles = createStyles((t) => ({
  block: { backgroundColor: t.color.surfaceSunken },
  control: { borderRadius: t.radius.control },
  card: { borderRadius: t.radius.card },
  pill: { borderRadius: t.radius.pill },
}));

/** Placeholder that matches the final shape. Pulses in opacity only, and stays still under reduced motion. */
export function Skeleton({ width, height, radius = "control" }: SkeletonProps) {
  const { motion } = useTheme();
  const styles = useSkeletonStyles();
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (reduced) {
      opacity.setValue(1);
      return;
    }
    const half = PULSE_MS / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: PULSE_LOW,
          duration: half,
          useNativeDriver: Platform.OS !== "web",
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: half,
          useNativeDriver: Platform.OS !== "web",
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [reduced, opacity, motion]);

  return (
    <Animated.View aria-hidden style={[styles.block, styles[radius], { width, height, opacity }]} />
  );
}
