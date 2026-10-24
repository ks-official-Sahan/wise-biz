import { format } from "@wise-biz/money";
import { memo, useMemo } from "react";

import { useTheme } from "../theme/ThemeProvider.tsx";
import { FONT_WEIGHT, lineHeightFor } from "../theme/typography.ts";

import { Text } from "./Text.tsx";

import type { TextTone, TextVariant } from "./Text.tsx";
import type { Money } from "@wise-biz/money";

export type MoneySize = "sm" | "md" | "lg" | "total";

export interface MoneyTextProps {
  readonly value: Money;
  readonly locale: string;
  readonly size?: MoneySize;
  readonly emphasis?: boolean;
  readonly tone?: TextTone;
}

const VARIANT: Readonly<Record<Exclude<MoneySize, "total">, TextVariant>> = {
  sm: "body",
  md: "heading",
  lg: "title",
};

/** Money in the numeric face with tabular figures. The total size uses the cart total token. */
export const MoneyText = memo(function MoneyText({
  value,
  locale,
  size = "md",
  emphasis = false,
  tone = "default",
}: MoneyTextProps) {
  const { component, lineHeight } = useTheme();
  const text = useMemo(() => format(value, locale), [value, locale]);
  const totalSize = component.cart.total.size;
  const totalStyle = useMemo(
    () => ({ fontSize: totalSize, lineHeight: lineHeightFor(totalSize, lineHeight.heading) }),
    [totalSize, lineHeight.heading],
  );
  const isTotal = size === "total";
  return (
    <Text
      variant={isTotal ? "title" : VARIANT[size]}
      tone={tone}
      numeric
      style={[
        isTotal ? totalStyle : undefined,
        emphasis ? { fontWeight: FONT_WEIGHT.medium } : undefined,
      ]}
    >
      {text}
    </Text>
  );
});
