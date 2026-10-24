import type { NativeTheme } from "@wise-biz/theme";
import type { ViewStyle } from "react-native";

const NO_RING: ViewStyle = Object.freeze({});

/** Visible focus ring (web keyboard focus). Width and offset come from the space scale (2 px). */
export function focusRingStyle(theme: NativeTheme, focused: boolean | undefined): ViewStyle {
  if (focused !== true) return NO_RING;
  return {
    outlineColor: theme.color.focusRing,
    outlineWidth: theme.space[1],
    outlineStyle: "solid",
    outlineOffset: theme.space[1],
  };
}
