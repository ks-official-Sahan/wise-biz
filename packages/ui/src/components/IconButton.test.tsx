import { IconX } from "@tabler/icons-react-native";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { IconButton } from "./IconButton.tsx";

describe("IconButton", () => {
  it("is found by its accessibility label and fires onPress", () => {
    const onPress = vi.fn();
    renderWithTheme(<IconButton icon={IconX} accessibilityLabel="Close" onPress={onPress} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("renders the secondary variant without press motion", () => {
    renderWithTheme(
      <IconButton
        icon={IconX}
        accessibilityLabel="Remove"
        onPress={() => undefined}
        variant="secondary"
        pressMotion={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("announces aria-disabled and ignores presses when disabled", () => {
    const onPress = vi.fn();
    renderWithTheme(
      <IconButton icon={IconX} accessibilityLabel="Remove" onPress={onPress} disabled />,
    );
    const button = screen.getByRole("button", { name: "Remove" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});
