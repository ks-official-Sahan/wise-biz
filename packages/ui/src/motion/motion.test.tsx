import { act, fireEvent, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TEST_THEME, renderWithTheme } from "../../test/render.tsx";
import { Button } from "../components/Button.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { ThemeProvider } from "../theme/ThemeProvider.tsx";
import { useReducedMotion } from "../theme/useReducedMotion.ts";

import type { ReactNode } from "react";
import type * as RNModule from "react-native";

// Animations run only when reduced motion is off. react-native-web reads matchMedia at import time,
// so this file mocks AccessibilityInfo to control the answer per test.
const motionState = vi.hoisted(() => ({
  reduced: false,
  reject: false,
  listener: undefined as ((value: boolean) => void) | undefined,
}));

vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof RNModule>();
  return {
    ...actual,
    AccessibilityInfo: {
      ...actual.AccessibilityInfo,
      isReduceMotionEnabled: () =>
        motionState.reject
          ? Promise.reject(new Error("unavailable"))
          : Promise.resolve(motionState.reduced),
      addEventListener: (_event: string, handler: (value: boolean) => void) => {
        motionState.listener = handler;
        return {
          remove: () => {
            motionState.listener = undefined;
          },
        };
      },
    },
  };
});

function wrapper({ children }: { readonly children: ReactNode }) {
  return <ThemeProvider theme={TEST_THEME}>{children}</ThemeProvider>;
}

describe("useReducedMotion", () => {
  it("is false until the platform answers, then reflects the setting", async () => {
    motionState.reduced = true;
    const { result } = renderHook(() => useReducedMotion(), { wrapper });
    expect(result.current).toBe(false);
    await vi.waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it("follows reduceMotionChanged and removes its listener on unmount", async () => {
    motionState.reduced = false;
    const { result, unmount } = renderHook(() => useReducedMotion(), { wrapper });
    await vi.waitFor(() => {
      expect(motionState.listener).toBeDefined();
    });
    act(() => {
      motionState.listener?.(true);
    });
    expect(result.current).toBe(true);
    unmount();
    expect(motionState.listener).toBeUndefined();
  });

  it("stays false when the platform query fails", async () => {
    motionState.reduced = true;
    motionState.reject = true;
    const { result } = renderHook(() => useReducedMotion(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
    motionState.reject = false;
  });
});

describe("animated components when motion is allowed", () => {
  it("runs the press scale on press and cleans up on unmount", async () => {
    motionState.reduced = false;
    const onPress = vi.fn();
    const { unmount } = renderWithTheme(<Button label="Add" onPress={onPress} />);
    await vi.waitFor(() => {
      expect(motionState.listener).toBeDefined();
    });
    const button = screen.getByRole("button", { name: "Add" });
    fireEvent.mouseDown(button);
    fireEvent.mouseUp(button);
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalled();
    unmount();
  });

  it("opens a sheet with the enter animation and closes it with the exit animation", async () => {
    motionState.reduced = false;
    const { rerender } = renderWithTheme(
      <Sheet visible title="Tender" onClose={() => undefined}>
        <span>Body</span>
      </Sheet>,
    );
    expect(screen.getByRole("dialog", { name: "Tender" })).toBeTruthy();
    rerender(
      <Sheet visible={false} title="Tender" onClose={() => undefined}>
        <span>Body</span>
      </Sheet>,
    );
    await vi.waitFor(
      () => {
        expect(screen.queryByRole("dialog", { name: "Tender" })).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  it("pulses a skeleton and stops the loop on unmount", async () => {
    motionState.reduced = false;
    const { unmount, container } = renderWithTheme(<Skeleton width={40} height={10} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    unmount();
  });
});
