import { createWedgeDetector } from "@wise-biz/barcode";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  preventDefault: () => void;
}

/**
 * Global keyboard-wedge capture (web and desktop): a scanner types a burst and Enter anywhere on the screen, whether or
 * not a field has focus. The burst is swallowed (not typed into a field); human typing passes through untouched.
 * Native HID scanners arrive as key events on a focused input and are added with the Android build (P1-12 follow-up).
 */
export function useWedgeScanner(onScan: (code: string) => void, enabled: boolean): void {
  const handler = useRef(onScan);
  useEffect(() => {
    handler.current = onScan;
  });

  useEffect(() => {
    if (!enabled || Platform.OS !== "web") return;
    const target = globalThis as unknown as {
      addEventListener?: (t: string, f: (e: KeyEventLike) => void, capture?: boolean) => void;
      removeEventListener?: (t: string, f: (e: KeyEventLike) => void, capture?: boolean) => void;
    };
    const detector = createWedgeDetector();
    const onKey = (e: KeyEventLike) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const r = detector.push(e.key, performance.now());
      if (r.type === "capturing") e.preventDefault();
      else if (r.type === "scan") {
        e.preventDefault();
        handler.current(r.code);
      }
    };
    target.addEventListener?.("keydown", onKey, true);
    return () => {
      target.removeEventListener?.("keydown", onKey, true);
    };
  }, [enabled]);
}
