import { TransportError } from "@wise-biz/sync";

/**
 * What the cashier reads when a request fails. Says what happened and what to do; never shows codes, stack traces or
 * which of "wrong PIN" and "no such user" it was (the server answers both the same).
 */
export function friendlyError(err: unknown, context: "enroll" | "pin"): string {
  if (err instanceof TransportError) {
    if (err.status === 0) return "No connection. Check the network and try again.";
    if (err.status === 429) return "Too many tries. Wait a minute and try again.";
    if (err.status >= 500) return "The server had a problem. Try again in a moment.";
    if (context === "enroll") return "That code did not work. Ask the owner for a new one.";
    return "That PIN did not work. Try again, or ask a manager.";
  }
  return "Something went wrong. Try again.";
}
