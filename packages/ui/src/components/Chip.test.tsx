import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { Chip } from "./Chip.tsx";

describe("Chip", () => {
  it("is a checkbox by default with aria-checked and fires onPress", () => {
    const onPress = vi.fn();
    renderWithTheme(<Chip label="Takeaway" selected onPress={onPress} />);
    const chip = screen.getByRole("checkbox", { name: "Takeaway" });
    expect(chip.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("is a radio when kind is radio and unselected", () => {
    renderWithTheme(
      <Chip label="Dine in" selected={false} onPress={() => undefined} kind="radio" />,
    );
    expect(screen.getByRole("radio", { name: "Dine in" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});
