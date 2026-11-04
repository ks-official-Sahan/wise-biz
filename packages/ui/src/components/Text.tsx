import { Text as NativeText } from "react-native";

import { headingAria } from "../a11y/web.ts";
import { createStyles } from "../theme/createStyles.ts";
import { FONT_WEIGHT, TABULAR_NUMS, lineHeightFor } from "../theme/typography.ts";

import type { HeadingLevel } from "../a11y/web.ts";
import type { ReactNode } from "react";
import type { StyleProp, TextStyle } from "react-native";

export type TextVariant = "display" | "title" | "heading" | "body" | "label" | "caption";
export type TextTone = "default" | "muted" | "accent" | "danger" | "success" | "warning";

export interface TextProps {
  readonly children?: ReactNode;
  readonly variant?: TextVariant;
  readonly tone?: TextTone;
  /** Tabular numerals in the numeric face. */
  readonly numeric?: boolean;
  /** Sets role "heading" and aria-level. */
  readonly headingLevel?: HeadingLevel;
  readonly nativeID?: string;
  readonly numberOfLines?: number;
  readonly style?: StyleProp<TextStyle>;
  readonly testID?: string;
}

const useVariantStyles = createStyles((t) => {
  const { fontSize, lineHeight, fontFamily } = t;
  return {
    display: {
      fontFamily: fontFamily.body,
      fontSize: fontSize["4xl"],
      lineHeight: lineHeightFor(fontSize["4xl"], lineHeight.heading),
      fontWeight: FONT_WEIGHT.medium,
    },
    title: {
      fontFamily: fontFamily.body,
      fontSize: fontSize["2xl"],
      lineHeight: lineHeightFor(fontSize["2xl"], lineHeight.heading),
      fontWeight: FONT_WEIGHT.medium,
    },
    heading: {
      fontFamily: fontFamily.body,
      fontSize: fontSize.xl,
      lineHeight: lineHeightFor(fontSize.xl, lineHeight.heading),
      fontWeight: FONT_WEIGHT.medium,
    },
    body: {
      fontFamily: fontFamily.body,
      fontSize: fontSize.md,
      lineHeight: lineHeightFor(fontSize.md, lineHeight.body),
      fontWeight: FONT_WEIGHT.regular,
    },
    label: {
      fontFamily: fontFamily.body,
      fontSize: fontSize.sm,
      lineHeight: lineHeightFor(fontSize.sm, lineHeight.body),
      fontWeight: FONT_WEIGHT.medium,
    },
    caption: {
      fontFamily: fontFamily.body,
      fontSize: fontSize.xs,
      lineHeight: lineHeightFor(fontSize.xs, lineHeight.body),
      fontWeight: FONT_WEIGHT.regular,
    },
  };
});

const useToneStyles = createStyles((t) => ({
  default: { color: t.color.text },
  muted: { color: t.color.textMuted },
  accent: { color: t.color.accentText },
  danger: { color: t.color.dangerText },
  success: { color: t.color.successText },
  warning: { color: t.color.warningText },
}));

const useNumericStyles = createStyles((t) => ({
  numeric: { fontFamily: t.fontFamily.numeric, fontVariant: TABULAR_NUMS },
}));

export function Text({
  children,
  variant = "body",
  tone = "default",
  numeric = false,
  headingLevel,
  nativeID,
  numberOfLines,
  style,
  testID,
}: TextProps) {
  const variants = useVariantStyles();
  const tones = useToneStyles();
  const numericStyles = useNumericStyles();
  return (
    <NativeText
      role={headingLevel === undefined ? undefined : "heading"}
      {...headingAria(headingLevel)}
      nativeID={nativeID}
      numberOfLines={numberOfLines}
      testID={testID}
      style={[variants[variant], tones[tone], numeric ? numericStyles.numeric : undefined, style]}
    >
      {children}
    </NativeText>
  );
}
