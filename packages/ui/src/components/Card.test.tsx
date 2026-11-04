import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { Card } from "./Card.tsx";

describe("Card", () => {
  it("renders a static surface with its children", () => {
    renderWithTheme(
      <Card>
        <span>Totals</span>
      </Card>,
    );
    expect(screen.getByText("Totals")).toBeTruthy();
  });

  it("is a named button when pressable", () => {
    const onPress = vi.fn();
    renderWithTheme(
      <Card onPress={onPress} accessibilityLabel="Open sale 1042">
        <span>Sale 1042</span>
      </Card>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open sale 1042" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
