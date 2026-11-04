import { useEffect, useRef } from "react";

/** Calls onEscape when Escape is pressed while active. Web only; a no-op on native. */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  const handler = useRef(onEscape);
  useEffect(() => {
    handler.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const listener = (event: KeyboardEvent): void => {
      if (event.key === "Escape") handler.current();
    };
    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
    };
  }, [active]);
}
