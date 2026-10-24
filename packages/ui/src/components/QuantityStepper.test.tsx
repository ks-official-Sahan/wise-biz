import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { QuantityStepper } from "./QuantityStepper.tsx";

describe("QuantityStepper", () => {
  it("exposes the value as a spinbutton with its bounds", () => {
    renderWithTheme(<QuantityStepper value={3} min={1} max={9} onChange={() => undefined} />);
    const spin = screen.getByRole("spinbutton", { name: "Quantity" });
    expect(spin.getAttribute("aria-valuenow")).toBe("3");
    expect(spin.getAttribute("aria-valuemin")).toBe("1");
    expect(spin.getAttribute("aria-valuemax")).toBe("9");
  });

  it("steps up and down within the bounds", () => {
    const onChange = vi.fn();
    renderWithTheme(<QuantityStepper value={3} min={1} max={9} onChange={onChange} label="Qty" />);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    expect(onChange).toHaveBeenLastCalledWith(4);
    fireEvent.click(screen.getByRole("button", { name: "Decrease quantity" }));
    expect(onChange).toHaveBeenLastCalledWith(2);
    expect(screen.getByRole("spinbutton", { name: "Qty" })).toBeTruthy();
  });

  it("disables both keys at their bounds and never emits out of range", () => {
    const onChange = vi.fn();
    const { rerender } = renderWithTheme(
      <QuantityStepper value={1} min={1} max={2} onChange={onChange} />,
    );
    const minus = screen.getByRole("button", { name: "Decrease quantity" });
    expect(minus.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(minus);
    expect(onChange).not.toHaveBeenCalled();

    rerender(<QuantityStepper value={2} min={1} max={2} onChange={onChange} />);
    const plus = screen.getByRole("button", { name: "Increase quantity" });
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(plus);
    expect(onChange).not.toHaveBeenCalled();
  });
});
