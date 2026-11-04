import { headers } from "next/headers";

import { platformThemeCss } from "@/lib/theme.ts";

import { Providers } from "./providers.tsx";

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "wise-biz console", template: "%s · wise-biz" },
  description: "Run your business: people, roles, branches and the audit log.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6faf8" },
    { media: "(prefers-color-scheme: dark)", color: "#121614" },
  ],
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // Reading the nonce makes every page dynamic, which a per-request CSP requires.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en">
      <head>
        <style nonce={nonce} dangerouslySetInnerHTML={{ __html: platformThemeCss() }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
