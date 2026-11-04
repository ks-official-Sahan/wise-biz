import { IconMinus, IconPlus } from "@tabler/icons-react-native";
import { Pressable, View } from "react-native";

import { createStyles } from "../theme/createStyles.ts";
import { focusRingStyle } from "../theme/focus.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import { IconButton } from "./IconButton.tsx";
import { Text } from "./Text.tsx";

import type { PressableState } from "../a11y/web.ts";

export interface QuantityStepperProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (next: number) => void;
  /** Accessible name of the value. Default "Quantity". */
  readonly label?: string;
  readonly testID?: string;
}

/** Step for Page Up and Page Down. */
const PAGE_STEP = 10;

const useStepperStyles = createStyles((t) => ({
  row: { flexDirection: "row", alignItems: "center", gap: t.target.gap },
  value: {
    minWidth: t.target.min,
    minHeight: t.target.min,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: t.radius.control,
  },
}));

/**
 * Quantity with minus and plus. Keys change background only (no motion), and disable at the bounds.
 * The value is a focusable spinbutton (APG): Arrow Up and Down step by 1, Page Up and Down by 10, Home and End
 * jump to the bounds. Screen readers announce the new aria-valuenow.
 */
export function QuantityStepper({
  value,
  min,
  max,
  onChange,
  label = "Quantity",
  testID,
}: QuantityStepperProps) {
  const theme = useTheme();
  const styles = useStepperStyles();
  const atMin = value <= min;
  const atMax = value >= max;
  const clamp = (next: number): number => Math.min(max, Math.max(min, next));
  const set = (next: number): void => {
    const bounded = clamp(next);
    if (bounded !== value) onChange(bounded);
  };

  return (
    <View role="group" accessibilityLabel={label} style={styles.row} testID={testID}>
      <IconButton
        icon={IconMinus}
        accessibilityLabel="Decrease quantity"
        disabled={atMin}
        pressMotion={false}
        onPress={() => {
          set(value - 1);
        }}
      />
      <Pressable
        role="spinbutton"
        accessibilityLabel={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={String(value)}
        tabIndex={0}
        onKeyDown={(event) => {
          let next: number;
          switch (event.nativeEvent.key) {
            case "ArrowUp":
              next = value + 1;
              break;
            case "ArrowDown":
              next = value - 1;
              break;
            case "PageUp":
              next = value + PAGE_STEP;
              break;
            case "PageDown":
              next = value - PAGE_STEP;
              break;
            case "Home":
              next = min;
              break;
            case "End":
              next = max;
              break;
            default:
              return;
          }
          event.preventDefault();
          set(next);
        }}
        style={(state: PressableState) => [styles.value, focusRingStyle(theme, state.focused)]}
      >
        <Text variant="heading" numeric>
          {String(value)}
        </Text>
      </Pressable>
      <IconButton
        icon={IconPlus}
        accessibilityLabel="Increase quantity"
        disabled={atMax}
        pressMotion={false}
        onPress={() => {
          set(value + 1);
        }}
      />
    </View>
  );
}
