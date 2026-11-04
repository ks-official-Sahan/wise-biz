import type { ViewStyle } from "react-native";

/** Stretch an absolutely positioned view over its parent (absoluteFillObject is not in RN 0.88 types). */
export const ABSOLUTE_FILL: ViewStyle = Object.freeze({
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
});
