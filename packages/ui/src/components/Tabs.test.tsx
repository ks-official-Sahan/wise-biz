import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { Tabs } from "./Tabs.tsx";

const items = [
  { key: "sell", label: "Sell" },
  { key: "hold", label: "Held" },
  { key: "refund", label: "Refund" },
];

describe("Tabs", () => {
  it("exposes a tablist with selected state and changes on press", () => {
    const onChange = vi.fn();
    renderWithTheme(
      <Tabs items={items} value="sell" onChange={onChange} accessibilityLabel="Modes" />,
    );
    expect(screen.getByRole("tablist", { name: "Modes" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Sell" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Held" }));
    expect(onChange).toHaveBeenCalledWith("hold");
  });

  it("moves selection with arrow, Home and End keys and wraps", () => {
    const onChange = vi.fn();
    renderWithTheme(<Tabs items={items} value="sell" onChange={onChange} />);
    const sell = screen.getByRole("tab", { name: "Sell" });
    fireEvent.keyDown(sell, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("hold");
    fireEvent.keyDown(sell, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("refund");
    fireEvent.keyDown(sell, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("refund");
    fireEvent.keyDown(sell, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("sell");
    fireEvent.keyDown(sell, { key: "a" });
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("keeps only the selected tab in the tab order", () => {
    renderWithTheme(<Tabs items={items} value="hold" onChange={() => undefined} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(
      tabs.map((tab) => (tab.getAttribute("aria-selected") === "true" ? "0" : "-1")),
    );
  });

  it("wraps from the last tab forwards", () => {
    const onChange = vi.fn();
    renderWithTheme(<Tabs items={items} value="refund" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Refund" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("sell");
  });
});
