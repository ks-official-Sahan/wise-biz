import type { CartLine } from "../../../state/slices.ts";

/** Removing or reducing a line within this long after it was added needs no permission (ux.md, undo). */
export const UNDO_WINDOW_MS = 5000;

export const EDIT_LINE_PERMISSION = "sales:edit_line";

export type EditKind = "remove" | "reduce";

export interface Permissions {
  readonly has: (permission: string) => boolean;
}

/**
 * Whether an edit that lowers a sale needs a supervisor. Within the undo window anyone may undo what they just did;
 * after it, the operator needs `sales:edit_line`. Raising a quantity is never gated.
 */
export function needsOverride(line: CartLine, now: number, perms: Permissions): boolean {
  if (now - line.addedAt <= UNDO_WINDOW_MS) return false;
  return !perms.has(EDIT_LINE_PERMISSION);
}

/** Session permissions as the sell screen reads them: `all` or a set (unknown means nothing is granted). */
export function permissionsOf(granted: readonly string[] | "all" | undefined): Permissions {
  return {
    has: (p) => granted === "all" || granted?.includes(p) === true,
  };
}
