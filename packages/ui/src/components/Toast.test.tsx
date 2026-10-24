import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithTheme } from "../../test/render.tsx";

import { ToastProvider, useToast } from "./Toast.tsx";

function Trigger({
  message,
  tone = "success",
  duration,
}: {
  readonly message: string;
  readonly tone?: "success" | "info" | "warning" | "danger";
  readonly duration?: number;
}) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        toast.show({ message, tone, duration });
      }}
    >
      show {message}
    </button>
  );
}

function setup(): void {
  renderWithTheme(
    <ToastProvider>
      <Trigger message="Saved" />
      <Trigger message="Offline" tone="warning" duration={1000} />
      <Trigger message="Card declined" tone="danger" />
      <Trigger message="Synced" tone="info" />
    </ToastProvider>,
  );
}

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a polite status for non-danger tones", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "show Saved" }));
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("announces danger assertively", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "show Card declined" }));
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain("Card declined");
  });

  it("dismisses after its duration (default 4 s)", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "show Saved" }));
    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("honours a custom duration", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "show Offline" }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("Offline")).toBeNull();
  });

  it("keeps at most three toasts and drops the oldest", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "show Saved" }));
    fireEvent.click(screen.getByRole("button", { name: "show Offline" }));
    fireEvent.click(screen.getByRole("button", { name: "show Card declined" }));
    fireEvent.click(screen.getByRole("button", { name: "show Synced" }));
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getByText("Synced")).toBeTruthy();
    expect(screen.getAllByRole("status").length + screen.getAllByRole("alert").length).toBe(3);
  });

  it("throws outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderWithTheme(<Trigger message="x" />)).toThrow(/inside <ToastProvider>/);
    spy.mockRestore();
  });
});
