import { useRef } from "react";
import { Pressable, View } from "react-native";

import { isFocusable } from "../a11y/web.ts";
import { createStyles } from "../theme/createStyles.ts";
import { focusRingStyle } from "../theme/focus.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import { Text } from "./Text.tsx";

import type { PressableState } from "../a11y/web.ts";

export interface TabItem {
  readonly key: string;
  /** Visible text and accessible name. */
  readonly label: string;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly value: string;
  readonly onChange: (key: string) => void;
  readonly accessibilityLabel?: string;
  readonly testID?: string;
}

const useTabStyles = createStyles((t) => ({
  list: { flexDirection: "row", gap: t.space[4] },
  tab: {
    minHeight: t.target.min,
    minWidth: t.target.min,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: t.space[2],
  },
  indicator: { alignSelf: "stretch", height: t.space[1] },
}));

/** Tabs with arrow, Home and End keys on web. The selected tab has a 2 px indicator as well as its color. */
export function Tabs({ items, value, onChange, accessibilityLabel, testID }: TabsProps) {
  const theme = useTheme();
  const styles = useTabStyles();
  const nodes = useRef(new Map<string, unknown>());

  const select = (index: number): void => {
    const item = items[index];
    if (item === undefined) return;
    onChange(item.key);
    const node = nodes.current.get(item.key);
    if (isFocusable(node)) node.focus();
  };

  return (
    <View
      role="tablist"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={styles.list}
    >
      {items.map((item, index) => {
        const selected = item.key === value;
        return (
          <Pressable
            key={item.key}
            role="tab"
            aria-selected={selected}
            ref={(node: unknown) => {
              if (node) nodes.current.set(item.key, node);
              else nodes.current.delete(item.key);
            }}
            onPress={() => {
              onChange(item.key);
            }}
            onKeyDown={(event) => {
              const last = items.length - 1;
              let next: number;
              switch (event.nativeEvent.key) {
                case "ArrowRight":
                  next = index === last ? 0 : index + 1;
                  break;
                case "ArrowLeft":
                  next = index === 0 ? last : index - 1;
                  break;
                case "Home":
                  next = 0;
                  break;
                case "End":
                  next = last;
                  break;
                default:
                  return;
              }
              event.preventDefault();
              select(next);
            }}
            style={(state: PressableState) => [styles.tab, focusRingStyle(theme, state.focused)]}
          >
            <View style={{ alignItems: "center", gap: theme.space[1] }}>
              <Text variant="label" tone={selected ? "accent" : "muted"}>
                {item.label}
              </Text>
              <View
                aria-hidden
                style={[
                  styles.indicator,
                  { backgroundColor: selected ? theme.color.accent : undefined },
                ]}
              />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
