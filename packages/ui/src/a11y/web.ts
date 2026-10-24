import type { PressableStateCallbackType } from "react-native";

/** Pressable state with the web-only keys react-native-web adds (focus and hover). */
export type PressableState = PressableStateCallbackType & {
  readonly focused?: boolean;
  readonly hovered?: boolean;
};

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** ARIA attributes that RN 0.88 types do not declare. react-native-web forwards them to the DOM. */
export interface WebAriaProps {
  readonly "aria-level"?: number;
  readonly "aria-invalid"?: boolean;
  readonly "aria-describedby"?: string;
}

/** Keeps a disabled Pressable in the tab order (RNW removes it when disabled); it still announces aria-disabled. */
export const FOCUSABLE_WHEN_DISABLED: { readonly tabIndex: 0 } = { tabIndex: 0 };

export function headingAria(level: number | undefined): WebAriaProps {
  return level === undefined ? {} : { "aria-level": level };
}

/** True for a mounted host node that can take focus (DOM element on web). */
export function isFocusable(node: unknown): node is { focus(): void } {
  return (
    typeof node === "object" && node !== null && "focus" in node && typeof node.focus === "function"
  );
}
