import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

import type { EventSubscription } from "react-native";

/** Subscription is typed optional: react-native-web returns nothing when matchMedia is missing. */
function listenForMotion(handler: (value: boolean) => void): EventSubscription | undefined {
  return AccessibilityInfo.addEventListener("reduceMotionChanged", handler);
}

/** True when the user asked for reduced motion. False until the platform answers. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (active) setReduced(value);
      },
      () => undefined,
    );
    // react-native-web returns no subscription when matchMedia is missing, so the type is widened.
    const subscription = listenForMotion((value) => {
      if (active) setReduced(value);
    });
    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);
  return reduced;
}
