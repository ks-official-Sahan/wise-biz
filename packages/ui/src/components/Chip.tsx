import { IconCheck } from "@tabler/icons-react-native";
import { Animated, Pressable } from "react-native";

import { usePressFeedback } from "../motion/usePressFeedback.ts";
import { createStyles } from "../theme/createStyles.ts";
import { focusRingStyle } from "../theme/focus.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

import type { PressableState } from "../a11y/web.ts";

export interface ChipProps {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  /** Sets role and aria-checked. Defaults to "checkbox". Use "switch" for an on/off setting. */
  readonly kind?: "checkbox" | "radio" | "switch";
  readonly testID?: string;
}

const useChipStyles = createStyles((t) => ({
  base: {
    minHeight: t.target.min,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: t.space[2],
    paddingHorizontal: t.space[4],
    borderRadius: t.radius.pill,
  },
}));

/** Selection is shown by a check mark as well as color, so it never depends on color alone. */
export function Chip({ label, selected, onPress, kind = "checkbox", testID }: ChipProps) {
  const theme = useTheme();
  const styles = useChipStyles();
  const press = usePressFeedback();
  const { component, color } = theme;
  const chip = component.chip;

  const resolve = (state: PressableState): { background: string; foreground: string } => {
    const lifted = state.pressed || state.hovered === true;
    if (selected) {
      return {
        background: lifted ? color.accentHover : chip.bgSelected,
        foreground: chip.fgSelected,
      };
    }
    return { background: lifted ? color.surfaceRaised : chip.bg, foreground: chip.fg };
  };

  return (
    <Animated.View style={press.style}>
      <Pressable
        role={kind}
        aria-checked={selected}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        testID={testID}
        style={(state: PressableState) => [
          styles.base,
          { backgroundColor: resolve(state).background },
          focusRingStyle(theme, state.focused),
        ]}
      >
        {(state: PressableState) => {
          const { foreground } = resolve(state);
          return (
            <>
              {selected ? <Icon icon={IconCheck} color={foreground} /> : null}
              <Text variant="label" style={{ color: foreground }}>
                {label}
              </Text>
            </>
          );
        }}
      </Pressable>
    </Animated.View>
  );
}
