import { IconAlertTriangle } from "@tabler/icons-react-native";
import { useId, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { createStyles } from "../theme/createStyles.ts";
import { focusRingStyle } from "../theme/focus.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";

import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

import type { WebAriaProps } from "../a11y/web.ts";
import type { TextInputProps } from "react-native";

export interface TextFieldProps {
  /** Visible label above the input. It is also the accessible name. */
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly helper?: string;
  readonly error?: string;
  readonly placeholder?: string;
  readonly keyboardType?: TextInputProps["keyboardType"];
  readonly autoCapitalize?: TextInputProps["autoCapitalize"];
  readonly secureTextEntry?: boolean;
  readonly testID?: string;
}

const useFieldStyles = createStyles((t) => ({
  root: { gap: t.space[1] },
  input: {
    minHeight: Math.max(t.control.control, t.target.min),
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: t.radius.control,
    paddingHorizontal: t.space[4],
    fontFamily: t.fontFamily.body,
    fontSize: t.fontSize.md,
  },
  note: { flexDirection: "row", alignItems: "center", gap: t.space[1] },
}));

/** Text input with a visible label. Errors are linked to the input and carry an icon, not only color. */
export function TextField({
  label,
  value,
  onChangeText,
  helper,
  error,
  placeholder,
  keyboardType,
  autoCapitalize,
  secureTextEntry,
  testID,
}: TextFieldProps) {
  const theme = useTheme();
  const styles = useFieldStyles();
  const id = useId();
  const [focused, setFocused] = useState(false);
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const showHelper = helper !== undefined && error === undefined;
  const described = [error === undefined ? null : errorId, showHelper ? helperId : null]
    .filter((item): item is string => item !== null)
    .join(" ");
  const aria: WebAriaProps = {
    "aria-invalid": error !== undefined,
    ...(described === "" ? {} : { "aria-describedby": described }),
  };

  return (
    <View style={styles.root}>
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.component.input.placeholder}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        secureTextEntry={secureTextEntry}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
        }}
        testID={testID}
        {...aria}
        style={[
          styles.input,
          {
            color: theme.component.input.text,
            backgroundColor: theme.component.input.bg,
            borderColor: focused ? theme.component.input.borderFocus : theme.component.input.border,
          },
          focusRingStyle(theme, focused),
        ]}
      />
      {helper === undefined || error !== undefined ? null : (
        <Text nativeID={helperId} variant="caption" tone="muted">
          {helper}
        </Text>
      )}
      {error === undefined ? null : (
        <View style={styles.note}>
          <Icon icon={IconAlertTriangle} color={theme.color.dangerText} size={theme.fontSize.md} />
          <Text nativeID={errorId} variant="label" tone="danger">
            {error}
          </Text>
        </View>
      )}
    </View>
  );
}
