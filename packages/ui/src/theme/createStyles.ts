import { StyleSheet } from "react-native";

import { useTheme } from "./ThemeProvider.tsx";

import type { NativeTheme } from "@wise-biz/theme";
import type { ImageStyle, TextStyle, ViewStyle } from "react-native";

type StyleMap = Record<string, ViewStyle | TextStyle | ImageStyle>;

/**
 * Build a style hook from a theme factory. The sheet is created once per NativeTheme object (WeakMap),
 * so a re-render with the same theme never calls StyleSheet.create again.
 */
export function createStyles<T extends StyleMap>(factory: (theme: NativeTheme) => T): () => T {
  const cache = new WeakMap<NativeTheme, T>();
  return function useStyles(): T {
    const theme = useTheme();
    const cached = cache.get(theme);
    if (cached !== undefined) return cached;
    const sheet = StyleSheet.create(factory(theme));
    cache.set(theme, sheet);
    return sheet;
  };
}
