import { IconPlus } from "@tabler/icons-react-native";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { Button } from "./Button.tsx";

describe("Button", () => {
  it("is found by role and visible label and fires onPress", () => {
    const onPress = vi.fn();
    renderWithTheme(<Button label="Pay LKR 1,403.00" onPress={onPress} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay LKR 1,403.00" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("renders every variant and size, with an icon", () => {
    renderWithTheme(
      <>
        <Button label="Primary" onPress={() => undefined} icon={IconPlus} size="lg" fullWidth />
        <Button label="Secondary" onPress={() => undefined} variant="secondary" />
        <Button label="Ghost" onPress={() => undefined} variant="ghost" />
        <Button label="Danger" onPress={() => undefined} variant="danger" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Danger" })).toBeTruthy();
  });

  it("announces aria-disabled and does not fire when disabled", () => {
    const onPress = vi.fn();
    renderWithTheme(<Button label="Void line" onPress={onPress} disabled />);
    const button = screen.getByRole("button", { name: "Void line" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("is busy and ignores presses while loading", () => {
    const onPress = vi.fn();
    renderWithTheme(<Button label="Saving" onPress={onPress} loading />);
    const button = screen.getByRole("button", { name: "Saving" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("guards double submits while an async press is pending", async () => {
    let finish: () => void = () => undefined;
    const onPress = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderWithTheme(<Button label="Pay" onPress={onPress} />);
    const button = screen.getByRole("button", { name: "Pay" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => {
      fireEvent.click(button);
      expect(onPress).toHaveBeenCalledTimes(2);
    });
  });

  it("releases the guard when the async press rejects", async () => {
    const onPress = vi.fn(() => Promise.reject(new Error("declined")));
    renderWithTheme(<Button label="Retry" onPress={onPress} />);
    const button = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(button);
    await vi.waitFor(() => {
      fireEvent.click(button);
      expect(onPress).toHaveBeenCalledTimes(2);
    });
  });
});
