import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { ListRow } from "./ListRow.tsx";

describe("ListRow", () => {
  it("renders title, subtitle and slots", () => {
    renderWithTheme(
      <ListRow
        title="Basmati rice 5 kg"
        subtitle="SKU 8901"
        leading={<span>L</span>}
        trailing={<span>T</span>}
        divider
        testID="row"
      />,
    );
    expect(screen.getByText("Basmati rice 5 kg")).toBeTruthy();
    expect(screen.getByText("SKU 8901")).toBeTruthy();
  });

  it("is a named button when pressable, without subtitle", () => {
    const onPress = vi.fn();
    renderWithTheme(<ListRow title="Refund" onPress={onPress} />);
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
