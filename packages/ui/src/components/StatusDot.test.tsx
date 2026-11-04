import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { StatusDot } from "./StatusDot.tsx";

describe("StatusDot", () => {
  it("announces its visible label as a status for every tone", () => {
    renderWithTheme(
      <>
        <StatusDot tone="warning" label="Offline, 3 sales queued" />
        <StatusDot tone="success" label="Synced" />
        <StatusDot tone="danger" label="Terminal down" />
        <StatusDot tone="info" label="Updating" />
      </>,
    );
    expect(screen.getAllByRole("status")).toHaveLength(4);
    expect(screen.getByText("Offline, 3 sales queued")).toBeTruthy();
  });
});
