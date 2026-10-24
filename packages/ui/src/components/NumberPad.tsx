import { IconBackspace } from "@tabler/icons-react-native";
import { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";

import { createStyles } from "../theme/createStyles.ts";
import { focusRingStyle } from "../theme/focus.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

import type { PressableState } from "../a11y/web.ts";

export type DigitKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
export type NumberPadKey = DigitKey | "00" | "." | "delete";

export interface NumberPadProps {
  readonly onKey: (key: NumberPadKey) => void;
  /** Enter on a physical keyboard (web). */
  readonly onSubmit?: () => void;
  /** Shows a decimal key in place of 00. */
  readonly allowDecimal?: boolean;
  /**
   * Listens to physical keys on web while true (digits anywhere outside text fields; Enter and Backspace only
   * when no control has focus). This is the off switch for the single-key shortcuts (WCAG 2.1.4).
   */
  readonly active?: boolean;
  readonly testID?: string;
}

const KEY_LABEL: Readonly<Record<NumberPadKey, string>> = {
  "0": "Digit 0",
  "1": "Digit 1",
  "2": "Digit 2",
  "3": "Digit 3",
  "4": "Digit 4",
  "5": "Digit 5",
  "6": "Digit 6",
  "7": "Digit 7",
  "8": "Digit 8",
  "9": "Digit 9",
  "00": "Double zero",
  ".": "Decimal point",
  delete: "Delete",
};

const useKeyStyles = createStyles((t) => ({
  grid: { gap: t.target.gap },
  row: { flexDirection: "row", gap: t.target.gap },
  key: {
    flex: 1,
    minHeight: t.control.key,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: t.radius.control,
  },
}));

function isEditable(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** A focused control (button, link, tab, checkbox...) owns Enter and Backspace; the pad must not steal them. */
function isControl(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target === document.body || target === document.documentElement) return false;
  return (
    ["BUTTON", "A"].includes(target.tagName) || target.hasAttribute("role") || target.tabIndex >= 0
  );
}

/** 4 x 3 keypad. Keys change background on press and do not animate: keypad input is keyboard-like. */
export function NumberPad({
  onKey,
  onSubmit,
  allowDecimal = false,
  active = false,
  testID,
}: NumberPadProps) {
  const theme = useTheme();
  const styles = useKeyStyles();
  const handlers = useRef({ onKey, onSubmit, allowDecimal });

  useEffect(() => {
    handlers.current = { onKey, onSubmit, allowDecimal };
  }, [onKey, onSubmit, allowDecimal]);

  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const listener = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditable(event.target)) return;
      const current = handlers.current;
      if (/^[0-9]$/.test(event.key)) {
        current.onKey(event.key as DigitKey);
      } else if (event.key === "." || event.key === ",") {
        if (current.allowDecimal) current.onKey(".");
      } else if (event.key === "Backspace") {
        if (isControl(event.target)) return;
        current.onKey("delete");
      } else if (event.key === "Enter") {
        if (isControl(event.target)) return;
        current.onSubmit?.();
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
    };
  }, [active]);

  const bottomLeft: NumberPadKey = allowDecimal ? "." : "00";
  const rows: readonly (readonly NumberPadKey[])[] = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    [bottomLeft, "0", "delete"],
  ];

  const renderKey = (key: NumberPadKey) => (
    <Pressable
      key={key}
      role="button"
      accessibilityLabel={KEY_LABEL[key]}
      onPress={() => {
        onKey(key);
      }}
      style={(state: PressableState) => [
        styles.key,
        {
          backgroundColor:
            state.pressed || state.hovered === true
              ? theme.color.surfaceSunken
              : theme.component.keypad.key.bg,
        },
        focusRingStyle(theme, state.focused),
      ]}
    >
      {key === "delete" ? (
        <Icon icon={IconBackspace} color={theme.component.keypad.key.fg} />
      ) : (
        <Text variant="heading" numeric>
          {key}
        </Text>
      )}
    </Pressable>
  );

  return (
    <View role="group" accessibilityLabel="Keypad" testID={testID} style={styles.grid}>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((key) => renderKey(key))}
        </View>
      ))}
    </View>
  );
}
