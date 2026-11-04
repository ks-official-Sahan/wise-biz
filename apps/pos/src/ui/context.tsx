import { createContext, useContext } from "react";

import type { Controller } from "../runtime/controller.ts";
import type { ReactNode } from "react";

const ControllerContext = createContext<Controller | null>(null);

export function ControllerProvider({
  controller,
  children,
}: {
  controller: Controller;
  children: ReactNode;
}) {
  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>;
}

/** The app controller (enroll, unlock, health). Screens call it; they never touch the network themselves. */
export function useController(): Controller {
  const c = useContext(ControllerContext);
  if (c === null) throw new Error("useController must be used inside ControllerProvider");
  return c;
}
