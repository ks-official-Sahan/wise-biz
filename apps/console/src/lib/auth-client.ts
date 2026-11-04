"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Better Auth client for the API's identity module (mounted at /v1/auth, proxied same-origin). Plugins match the server:
 * emailed-OTP two-factor and passkeys. On `twoFactorRedirect` the sign-in page switches to the code step.
 */
export const authClient = createAuthClient({
  basePath: "/v1/auth",
  plugins: [twoFactorClient(), passkeyClient()],
});
