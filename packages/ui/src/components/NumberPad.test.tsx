import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { NumberPad } from "./NumberPad.tsx";

describe("NumberPad", () => {
  it("labels every key and reports presses", () => {
    const onKey = vi.fn();
    renderWithTheme(<NumberPad onKey={onKey} />);
    for (const name of ["Digit 0", "Digit 1", "Digit 9", "Double zero", "Delete"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Digit 7" }));
    expect(onKey).toHaveBeenCalledWith("7");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onKey).toHaveBeenLastCalledWith("delete");
    fireEvent.click(screen.getByRole("button", { name: "Double zero" }));
    expect(onKey).toHaveBeenLastCalledWith("00");
  });

  it("shows a decimal key in place of 00 when decimals are allowed", () => {
    const onKey = vi.fn();
    renderWithTheme(<NumberPad onKey={onKey} allowDecimal />);
    expect(screen.queryByRole("button", { name: "Double zero" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Decimal point" }));
    expect(onKey).toHaveBeenCalledWith(".");
  });

  it("calls onKey for physical digits on web while active", () => {
    const onKey = vi.fn();
    renderWithTheme(<NumberPad onKey={onKey} active />);
    fireEvent.keyDown(document, { key: "7" });
    expect(onKey).toHaveBeenLastCalledWith("7");
    fireEvent.keyDown(document, { key: "Backspace" });
    expect(onKey).toHaveBeenLastCalledWith("delete");
    fireEvent.keyDown(document, { key: "a" });
    expect(onKey).toHaveBeenCalledTimes(2);
  });

  it("maps the decimal key only when decimals are allowed, and submits on Enter", () => {
    const onKey = vi.fn();
    const onSubmit = vi.fn();
    const { unmount } = renderWithTheme(<NumberPad onKey={onKey} onSubmit={onSubmit} active />);
    fireEvent.keyDown(document, { key: "." });
    expect(onKey).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    unmount();

    const decimalKey = vi.fn();
    renderWithTheme(<NumberPad onKey={decimalKey} allowDecimal active />);
    fireEvent.keyDown(document, { key: "," });
    expect(decimalKey).toHaveBeenCalledWith(".");
  });

  it("ignores keys while inactive and while typing in a field", () => {
    const onKey = vi.fn();
    const { rerender } = renderWithTheme(<NumberPad onKey={onKey} active={false} />);
    fireEvent.keyDown(document, { key: "5" });
    expect(onKey).not.toHaveBeenCalled();
    rerender(<NumberPad onKey={onKey} active />);
    const field = document.createElement("input");
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: "5" });
    expect(onKey).not.toHaveBeenCalled();
    field.remove();
  });

  it("leaves Enter and Backspace to a focused control but still takes digits", () => {
    const onKey = vi.fn();
    const onSubmit = vi.fn();
    renderWithTheme(<NumberPad onKey={onKey} onSubmit={onSubmit} active />);
    const control = document.createElement("button");
    document.body.append(control);
    fireEvent.keyDown(control, { key: "Enter" });
    fireEvent.keyDown(control, { key: "Backspace" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onKey).not.toHaveBeenCalled();
    fireEvent.keyDown(control, { key: "4" });
    expect(onKey).toHaveBeenLastCalledWith("4");
    control.remove();
  });
});
