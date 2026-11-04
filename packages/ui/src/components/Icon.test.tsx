import { IconSearch } from "@tabler/icons-react-native";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { ICON_STROKE_WIDTH, Icon } from "./Icon.tsx";

describe("Icon", () => {
  it("is hidden from assistive tech without a label", () => {
    const { container } = renderWithTheme(<Icon icon={IconSearch} />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("is a named image with a label, and accepts size and color", () => {
    renderWithTheme(
      <Icon icon={IconSearch} accessibilityLabel="Search" color="#000000" size={24} />,
    );
    expect(screen.getByRole("img", { name: "Search" })).toBeTruthy();
    expect(ICON_STROKE_WIDTH).toBe(1.75);
  });
});
