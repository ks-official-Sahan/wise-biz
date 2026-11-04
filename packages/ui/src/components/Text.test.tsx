import { screen } from "@testing-library/react";
import { money } from "@wise-biz/money";
import { describe, expect, it } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { MoneyText } from "./MoneyText.tsx";
import { Text } from "./Text.tsx";

describe("Text", () => {
  it("renders every variant and tone", () => {
    renderWithTheme(
      <>
        <Text variant="display">Display</Text>
        <Text variant="title" tone="muted">
          Title
        </Text>
        <Text variant="heading" tone="accent">
          Heading
        </Text>
        <Text variant="body" tone="danger">
          Body
        </Text>
        <Text variant="label" tone="success">
          Label
        </Text>
        <Text variant="caption" tone="warning">
          Caption
        </Text>
      </>,
    );
    expect(screen.getByText("Display")).toBeTruthy();
    expect(screen.getByText("Caption")).toBeTruthy();
  });

  it("exposes a heading role with aria-level when headingLevel is set", () => {
    renderWithTheme(<Text headingLevel={2}>Totals</Text>);
    expect(screen.getByRole("heading", { level: 2, name: "Totals" })).toBeTruthy();
  });

  it("is a plain text node without headingLevel", () => {
    renderWithTheme(
      <Text numeric testID="plain">
        Qty 3
      </Text>,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByTestId("plain").textContent).toBe("Qty 3");
  });
});

describe("MoneyText", () => {
  it("formats minor units with tabular numerals in the given locale", () => {
    renderWithTheme(<MoneyText value={money(140300, "LKR")} locale="en" />);
    expect(screen.getByText(/1,403\.00/)).toBeTruthy();
  });

  it("renders every size, emphasis and tone", () => {
    renderWithTheme(
      <>
        <MoneyText value={money(100, "USD")} locale="en" size="sm" />
        <MoneyText value={money(200, "USD")} locale="en" size="md" emphasis tone="accent" />
        <MoneyText value={money(300, "USD")} locale="en" size="lg" />
        <MoneyText value={money(400, "USD")} locale="en" size="total" />
      </>,
    );
    expect(screen.getByText(/4\.00/)).toBeTruthy();
    expect(screen.getByText(/2\.00/)).toBeTruthy();
  });
});
