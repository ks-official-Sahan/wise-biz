import { IconSearch, IconX } from "@tabler/icons-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { isFocusable } from "../a11y/web.ts";
import { createStyles } from "../theme/createStyles.ts";
import { focusRingStyle } from "../theme/focus.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import { Icon } from "./Icon.tsx";
import { IconButton } from "./IconButton.tsx";

import type { TextInputProps } from "react-native";

export interface SearchFieldProps {
  /** Accessible name (not visible). */
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  /** Called after typing pauses for debounceMs, and at once on Enter or clear. */
  readonly onSearch: (query: string) => void;
  /** Default 150 ms. */
  readonly debounceMs?: number | undefined;
  readonly placeholder?: string;
  readonly testID?: string;
}

const DEFAULT_DEBOUNCE_MS = 150;

const useSearchStyles = createStyles((t) => ({
  root: {
    flexDirection: "row",
    alignItems: "center",
    gap: t.space[2],
    minHeight: Math.max(t.control.control, t.target.min),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: t.radius.control,
    paddingLeft: t.space[4],
    paddingRight: t.space[1],
  },
  input: {
    flex: 1,
    fontFamily: t.fontFamily.body,
    fontSize: t.fontSize.md,
    minHeight: t.target.min,
  },
}));

/**
 * Search with a debounced onSearch. Enter (scanners end a scan with Enter) searches immediately and
 * cancels the pending debounce. Focus returns to the field after clear.
 */
export function SearchField({
  label,
  value,
  onChangeText,
  onSearch,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  placeholder,
  testID,
}: SearchFieldProps) {
  const theme = useTheme();
  const styles = useSearchStyles();
  const inputNode = useRef<unknown>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(value);
  const onSearchRef = useRef(onSearch);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  useEffect(() => {
    latest.current = value;
  }, [value]);

  const cancel = useCallback((): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  useEffect(() => cancel, [cancel]);

  const handleChange = (text: string): void => {
    latest.current = text;
    onChangeText(text);
    cancel();
    timer.current = setTimeout(() => {
      timer.current = undefined;
      onSearchRef.current(text);
    }, debounceMs);
  };

  const submit = (): void => {
    cancel();
    onSearchRef.current(latest.current);
  };

  const clear = (): void => {
    cancel();
    latest.current = "";
    onChangeText("");
    onSearchRef.current("");
    if (isFocusable(inputNode.current)) inputNode.current.focus();
  };

  const inputProps: TextInputProps = {
    role: "searchbox",
    accessibilityLabel: label,
    placeholder,
    returnKeyType: "search",
    onSubmitEditing: submit,
    onFocus: () => {
      setFocused(true);
    },
    onBlur: () => {
      setFocused(false);
    },
  };

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: theme.component.input.bg,
          borderColor: focused ? theme.component.input.borderFocus : theme.component.input.border,
        },
      ]}
    >
      <Icon icon={IconSearch} color={theme.component.input.placeholder} />
      <TextInput
        ref={(node: unknown) => {
          inputNode.current = node;
        }}
        {...inputProps}
        value={value}
        onChangeText={handleChange}
        placeholderTextColor={theme.component.input.placeholder}
        testID={testID}
        style={[
          styles.input,
          { color: theme.component.input.text },
          focusRingStyle(theme, focused),
        ]}
      />
      {value.length === 0 ? null : (
        <IconButton
          icon={IconX}
          accessibilityLabel="Clear search"
          onPress={clear}
          variant="ghost"
        />
      )}
    </View>
  );
}
