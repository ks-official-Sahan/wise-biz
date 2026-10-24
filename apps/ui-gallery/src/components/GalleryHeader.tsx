import { Chip, Tabs, Text, createStyles, useThemeMode } from "@wise-biz/ui";
import { ScrollView, StyleSheet, View } from "react-native";

import { THEME_OPTIONS } from "../lib/urlState.ts";

import type { ThemeId, ViewKey } from "../lib/urlState.ts";

const useHeaderStyles = createStyles((t) => ({
  bar: {
    gap: t.space[2],
    paddingHorizontal: t.space[4],
    paddingVertical: t.space[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: t.color.border,
    backgroundColor: t.color.surface,
  },
  titleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: t.space[2],
  },
  controlRow: { flexDirection: "row", alignItems: "center", gap: t.space[2] },
  // One horizontal line of theme chips. It scrolls sideways on narrow screens instead of wrapping.
  chipScroll: { flex: 1, minWidth: 0, flexGrow: 1 },
  chipRow: { flexDirection: "row", alignItems: "center", gap: t.space[2] },
}));

const VIEW_ITEMS = [
  { key: "components", label: "Components" },
  { key: "sell", label: "Sell screen" },
] as const;

export interface GalleryHeaderProps {
  readonly themeId: ThemeId;
  readonly view: ViewKey;
  /** Last measured theme switch in ms, or null before the first switch. */
  readonly switchMs: number | null;
  readonly onThemeChange: (id: ThemeId) => void;
  readonly onViewChange: (view: ViewKey) => void;
}

export function GalleryHeader({
  themeId,
  view,
  switchMs,
  onThemeChange,
  onViewChange,
}: GalleryHeaderProps) {
  const styles = useHeaderStyles();
  const { mode, canToggle, setPreference } = useThemeMode();
  return (
    <View role="banner" style={styles.bar}>
      <View style={styles.titleRow}>
        <Text variant="title" headingLevel={1}>
          wise-biz UI gallery
        </Text>
        <Text variant="caption" tone="muted">
          {`Theme switch: ${switchMs === null ? "–" : String(switchMs)} ms`}
        </Text>
      </View>
      <View style={styles.controlRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipScroll}
          contentContainerStyle={styles.chipRow}
          role="radiogroup"
          accessibilityLabel="Theme"
          keyboardShouldPersistTaps="handled"
        >
          {THEME_OPTIONS.map((option) => (
            <Chip
              key={option.id}
              kind="radio"
              label={option.label}
              selected={option.id === themeId}
              onPress={() => {
                onThemeChange(option.id);
              }}
            />
          ))}
        </ScrollView>
        {canToggle ? (
          <Chip
            kind="switch"
            label="Dark mode"
            selected={mode === "dark"}
            onPress={() => {
              setPreference(mode === "dark" ? "light" : "dark");
            }}
          />
        ) : null}
      </View>
      <Tabs
        accessibilityLabel="Gallery view"
        items={VIEW_ITEMS}
        value={view}
        onChange={(key) => {
          onViewChange(key === "sell" ? "sell" : "components");
        }}
      />
    </View>
  );
}
