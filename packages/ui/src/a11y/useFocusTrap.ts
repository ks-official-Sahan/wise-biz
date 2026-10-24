import { useEffect, useRef } from "react";

import type { RefObject } from "react";

const FOCUSABLE =
  'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
/** Frames to wait for the panel: RN Modal on web mounts its portal a commit after the Modal itself. */
const MAX_ATTACH_FRAMES = 10;

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => !node.hasAttribute("disabled") && node.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Modal focus management on web (WCAG 2.4.3): on open, remembers the focused element and moves focus into the
 * panel (first focusable, else the panel); Tab and Shift+Tab cycle inside it; on close, focus returns to the
 * remembered element. A no-op on native, where RN Modal owns accessibility focus.
 */
export function useFocusTrap(active: boolean, panel: RefObject<unknown>): void {
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    returnTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let root: HTMLElement | null = null;
    let frame = 0;
    let tries = 0;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab" || root === null) return;
      const nodes = focusables(root);
      const first = nodes[0];
      const last = nodes.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        root.focus();
        return;
      }
      const current = document.activeElement;
      const inside = current instanceof Node && root.contains(current);
      if (event.shiftKey && (current === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };

    const attach = (): void => {
      const node = panel.current;
      if (!(node instanceof HTMLElement)) {
        tries += 1;
        if (tries < MAX_ATTACH_FRAMES) frame = requestAnimationFrame(attach);
        return;
      }
      root = node;
      if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "-1");
      (focusables(node)[0] ?? node).focus();
    };
    attach();
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      const target = returnTo.current;
      returnTo.current = null;
      if (target?.isConnected === true) target.focus();
    };
  }, [active, panel]);
}
