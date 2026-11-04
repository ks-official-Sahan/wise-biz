import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { SearchField } from "./SearchField.tsx";

function Uncontrolled({
  onSearch,
  debounceMs,
}: {
  readonly onSearch: (q: string) => void;
  readonly debounceMs?: number;
}) {
  return (
    <SearchField
      label="Search products"
      value=""
      onChangeText={() => undefined}
      onSearch={onSearch}
      debounceMs={debounceMs}
    />
  );
}

function Controlled({ onSearch }: { readonly onSearch: (q: string) => void }) {
  const [text, setText] = useState("");
  return (
    <SearchField label="Search products" value={text} onChangeText={setText} onSearch={onSearch} />
  );
}

describe("SearchField", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces onSearch while typing (default 150 ms)", () => {
    const onSearch = vi.fn();
    renderWithTheme(<Uncontrolled onSearch={onSearch} />);
    const input = screen.getByRole("searchbox", { name: "Search products" });
    fireEvent.change(input, { target: { value: "ca" } });
    fireEvent.change(input, { target: { value: "cap" } });
    expect(onSearch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(onSearch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("cap");
  });

  it("searches at once on Enter and cancels the pending debounce", () => {
    const onSearch = vi.fn();
    renderWithTheme(<Uncontrolled onSearch={onSearch} debounceMs={300} />);
    const input = screen.getByRole("searchbox", { name: "Search products" });
    fireEvent.change(input, { target: { value: "8901234" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSearch).toHaveBeenCalledWith("8901234");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("clears at once, refocuses the field and cancels the debounce", () => {
    const onSearch = vi.fn();
    renderWithTheme(<Controlled onSearch={onSearch} />);
    const input = screen.getByRole("searchbox", { name: "Search products" });
    fireEvent.change(input, { target: { value: "milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onSearch).toHaveBeenLastCalledWith("");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
  });

  it("clears its timer on unmount", () => {
    const onSearch = vi.fn();
    const { unmount } = renderWithTheme(<Uncontrolled onSearch={onSearch} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search products" }), {
      target: { value: "x" },
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("submits the latest text on Enter with a controlled value", () => {
    const onSearch = vi.fn();
    renderWithTheme(<Controlled onSearch={onSearch} />);
    const input = screen.getByRole("searchbox", { name: "Search products" });
    fireEvent.change(input, { target: { value: "tea" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSearch).toHaveBeenLastCalledWith("tea");
  });
});
