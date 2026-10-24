import { StyleSheet, View } from "react-native";

import { createStyles } from "../theme/createStyles.ts";

export interface DividerProps {
  readonly orientation?: "horizontal" | "vertical";
}

const useDividerStyles = createStyles((t) => ({
  horizontal: {
    alignSelf: "stretch",
    height: StyleSheet.hairlineWidth,
    backgroundColor: t.color.border,
  },
  vertical: {
    alignSelf: "stretch",
    width: StyleSheet.hairlineWidth,
    backgroundColor: t.color.border,
  },
}));

/** Hairline separator in the border color. */
export function Divider({ orientation = "horizontal" }: DividerProps) {
  const styles = useDividerStyles();
  return <View role="separator" style={styles[orientation]} />;
}
