import { SellScreen } from "../src/features/sell/SellScreen.tsx";
import { Gate } from "../src/ui/gate.tsx";

/** Home after unlock is the sell screen. */
export default function Home() {
  return (
    <Gate phase="unlocked">
      <SellScreen />
    </Gate>
  );
}
