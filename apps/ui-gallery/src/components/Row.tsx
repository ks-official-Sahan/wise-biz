import { createStyles } from "@wise-biz/ui";
import { View } from "react-native";

import type { ReactNode } from "react";
import type { ViewStyle } from "react-native";

const useRowStyles = createStyles((t) => ({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space[3] },
  column: { flexDirection: "column", alignItems: "flex-start", gap: t.space[3] },
}));

/** Wrapping horizontal group of controls. */
interface RowProps {
  readonly children: ReactNode;
  readonly style?: ViewStyle;
  /** Group semantics for related controls, such as radio chips. */
  readonly role?: "group" | "radiogroup";
  readonly accessibilityLabel?: string;
}

export function Row({ children, style, role, accessibilityLabel }: RowProps) {
  const styles = useRowStyles();
  return (
    <View role={role} accessibilityLabel={accessibilityLabel} style={[styles.row, style]}>
      {children}
    </View>
  );
}

/** Vertical group, left aligned, for a control with its helper text. */
export function Column({ children }: { readonly children: ReactNode }) {
  const styles = useRowStyles();
  return <View style={styles.column}>{children}</View>;
}
