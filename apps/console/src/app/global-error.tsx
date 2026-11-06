"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/** The last-resort error page (the root layout itself failed). It reports the error and offers a retry. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <main role="alert">
          <h1>Something went wrong</h1>
          <p>The page could not be shown. Your data is safe. Try again, or reload the page.</p>
          <button type="button" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
