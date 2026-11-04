import { IconAlertTriangle } from "@tabler/icons-react-native";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { Badge } from "./Badge.tsx";

describe("Badge", () => {
  it("shows its label with and without an icon, for every tone", () => {
    renderWithTheme(
      <>
        <Badge tone="danger" label="Expired" icon={IconAlertTriangle} />
        <Badge tone="warning" label="Low stock" />
        <Badge tone="success" label="Synced" />
        <Badge tone="info" label="Draft" />
      </>,
    );
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
  });
});
