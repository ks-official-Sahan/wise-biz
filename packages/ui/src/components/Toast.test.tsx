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

  it("inserts messages into an always-mounted polite live region", () => {
    setup();
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByRole("button", { name: "show Saved" }));
    expect(screen.getByRole("status").textContent).toContain("Saved");
  });

  it("announces danger as an alert and keeps it until dismissed", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "show Card declined" }));
    expect(screen.getByRole("alert").textContent).toContain("Card declined");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("Card declined")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Card declined")).toBeNull();
  });

  it("pauses timers while the pointer is over the stack", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "show Saved" }));
    const stack = screen.getByRole("status");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    fireEvent.pointerEnter(stack);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("Saved")).toBeTruthy();
    fireEvent.pointerLeave(stack);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Saved")).toBeNull();
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
    expect(screen.getAllByRole("button", { name: "Dismiss notification" })).toHaveLength(3);
  });

  it("throws outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderWithTheme(<Trigger message="x" />)).toThrow(/inside <ToastProvider>/);
    spy.mockRestore();
  });
});
