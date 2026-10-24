import { IconMinus, IconPlus } from "@tabler/icons-react-native";
import { View } from "react-native";

import { createStyles } from "../theme/createStyles.ts";

import { IconButton } from "./IconButton.tsx";
import { Text } from "./Text.tsx";

export interface QuantityStepperProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (next: number) => void;
  /** Accessible name of the value. Default "Quantity". */
  readonly label?: string;
  readonly testID?: string;
}

const useStepperStyles = createStyles((t) => ({
  row: { flexDirection: "row", alignItems: "center", gap: t.target.gap },
  value: { minWidth: t.target.min, alignItems: "center", justifyContent: "center" },
}));

/**
 * Quantity with minus and plus. Keys change background only (no motion), and disable at the bounds.
 * The value is exposed as a spinbutton with aria-valuenow, aria-valuemin and aria-valuemax.
 */
export function QuantityStepper({
  value,
  min,
  max,
  onChange,
  label = "Quantity",
  testID,
}: QuantityStepperProps) {
  const styles = useStepperStyles();
  const atMin = value <= min;
  const atMax = value >= max;

  return (
    <View style={styles.row} testID={testID}>
      <IconButton
        icon={IconMinus}
        accessibilityLabel="Decrease quantity"
        disabled={atMin}
        pressMotion={false}
        onPress={() => {
          if (!atMin) onChange(Math.max(min, value - 1));
        }}
      />
      <View
        role="spinbutton"
        accessibilityLabel={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={String(value)}
        style={styles.value}
      >
        <Text variant="heading" numeric>
          {String(value)}
        </Text>
      </View>
      <IconButton
        icon={IconPlus}
        accessibilityLabel="Increase quantity"
        disabled={atMax}
        pressMotion={false}
        onPress={() => {
          if (!atMax) onChange(Math.min(max, value + 1));
        }}
      />
    </View>
  );
}
