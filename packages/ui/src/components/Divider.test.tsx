import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { Divider } from "./Divider.tsx";

describe("Divider", () => {
  it("is a separator in either orientation", () => {
    renderWithTheme(
      <>
        <Divider />
        <Divider orientation="vertical" />
      </>,
    );
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });
});
