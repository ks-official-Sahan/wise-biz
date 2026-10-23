import { describe, expect, it } from "vitest";

import { componentTokens } from "./component.ts";
import { PLATFORM_THEME } from "./defaults.ts";
import { scalesFor } from "./scales.ts";
import { parseThemeInput } from "./schema.ts";
import { buildModeColors } from "./semantic.ts";

describe("componentTokens", () => {
  it("derives component values from semantic colors and scales", () => {
    const input = parseThemeInput(structuredClone(PLATFORM_THEME));
    const color = buildModeColors(input, "light");
    const comfortable = scalesFor("comfortable");
    const component = componentTokens(color, comfortable);

    expect(component.button.primary.bg).toBe(color.accent);
    expect(component.button.primary.fg).toBe(color.textOnAccent);
    expect(component.input.placeholder).toBe(color.textMuted);
    expect(component.input.borderFocus).toBe(color.focusRing);
    expect(component.keypad.key.height).toBe(56);
    expect(component.cart.total.size).toBe(48);
    expect(component.toast).toEqual({ bg: color.text, fg: color.surface });
    expect(component.badge.danger).toEqual({ bg: color.dangerSubtle, fg: color.dangerText });
    expect(component.chip.fgSelected).toBe(color.accentText);
  });

  it("is a pure function of its inputs", () => {
    const input = parseThemeInput(structuredClone(PLATFORM_THEME));
    const color = buildModeColors(input, "dark");
    const compact = scalesFor("compact");
    expect(componentTokens(color, compact)).toEqual(componentTokens(color, compact));
    expect(componentTokens(color, compact).keypad.key.height).toBe(48);
  });
});
