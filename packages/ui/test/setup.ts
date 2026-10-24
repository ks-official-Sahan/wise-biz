import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals, so Testing Library does not clean up between tests on its own.
afterEach(() => {
  cleanup();
});
