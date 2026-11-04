import { Redirect } from "expo-router";

import { ROUTE_FOR_PHASE } from "../src/ui/gate.tsx";
import { useAppSelector } from "../src/ui/hooks.ts";

/** Entry: sends the terminal to the screen its phase belongs to. */
export default function Index() {
  const phase = useAppSelector((s) => s.session.phase);
  return <Redirect href={ROUTE_FOR_PHASE[phase]} />;
}
