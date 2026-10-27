/**
 * Loads the Better Auth client (passkey and two-factor plugins) on demand, so it stays out of the first-load bundle
 * of the sign-in and sign-up pages. Pages warm it after mount; by the time a form is submitted it is cached.
 */
export const loadAuth = () => import("./auth-client.ts").then((m) => m.authClient);
