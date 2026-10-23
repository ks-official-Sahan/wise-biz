import type { StatusKind } from "./palette.ts";
import type { Scales } from "./scales.ts";
import type { ModeColors } from "./tokens.ts";

export interface ButtonTokens {
  readonly bg: string;
  readonly fg: string;
  readonly border: string;
  readonly bgPressed: string;
}

export interface BadgeTokens {
  readonly bg: string;
  readonly fg: string;
}

export interface ComponentTokens {
  readonly button: {
    readonly primary: ButtonTokens;
    readonly secondary: ButtonTokens;
    readonly ghost: ButtonTokens;
    readonly danger: ButtonTokens;
  };
  readonly input: {
    readonly bg: string;
    readonly border: string;
    readonly borderFocus: string;
    readonly text: string;
    readonly placeholder: string;
  };
  readonly cart: { readonly total: { readonly size: number } };
  readonly keypad: {
    readonly key: { readonly height: number; readonly bg: string; readonly fg: string };
  };
  readonly chip: {
    readonly bg: string;
    readonly fg: string;
    readonly bgSelected: string;
    readonly fgSelected: string;
  };
  readonly toast: { readonly bg: string; readonly fg: string };
  readonly badge: Readonly<Record<StatusKind, BadgeTokens>>;
}

/** Component tokens for one mode. Pure function of semantic colors and scales. */
export function componentTokens(color: ModeColors, scales: Scales): ComponentTokens {
  return {
    button: {
      primary: {
        bg: color.accent,
        fg: color.textOnAccent,
        border: color.accent,
        bgPressed: color.accentPressed,
      },
      secondary: {
        bg: color.surface,
        fg: color.text,
        border: color.borderStrong,
        bgPressed: color.surfaceSunken,
      },
      ghost: {
        bg: color.canvas,
        fg: color.accentText,
        border: color.canvas,
        bgPressed: color.accentSubtle,
      },
      danger: {
        bg: color.danger,
        fg: color.onDanger,
        border: color.danger,
        bgPressed: color.danger,
      },
    },
    input: {
      bg: color.surface,
      border: color.borderStrong,
      borderFocus: color.focusRing,
      text: color.text,
      placeholder: color.textMuted,
    },
    cart: { total: { size: scales.cartTotal } },
    keypad: { key: { height: scales.control.key, bg: color.surfaceRaised, fg: color.text } },
    chip: {
      bg: color.surfaceSunken,
      fg: color.text,
      bgSelected: color.accentSubtle,
      fgSelected: color.accentText,
    },
    toast: { bg: color.text, fg: color.surface },
    badge: {
      danger: { bg: color.dangerSubtle, fg: color.dangerText },
      warning: { bg: color.warningSubtle, fg: color.warningText },
      success: { bg: color.successSubtle, fg: color.successText },
      info: { bg: color.infoSubtle, fg: color.infoText },
    },
  };
}
