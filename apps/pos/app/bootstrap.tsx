import { Badge, Text } from "@wise-biz/ui";

import { DATASETS } from "../src/runtime/controller.ts";
import { Gate } from "../src/ui/gate.tsx";
import { useSyncHealth } from "../src/ui/hooks.ts";
import { Screen } from "../src/ui/screen.tsx";

const LABEL: Record<string, string> = {
  catalog: "Products",
  prices: "Prices",
  tax: "Taxes",
  promotions: "Promotions",
  stock_branch: "Stock",
};

/** First sync: every dataset needs its snapshot once. After that the terminal works offline. */
export default function Bootstrap() {
  const health = useSyncHealth(800);
  const pending = new Set<string>(health?.pendingBootstrap ?? DATASETS);
  return (
    <Gate phase="enrolled">
      <Screen
        title="Getting ready"
        subtitle="Downloading your products, prices and taxes. This happens once."
      >
        {DATASETS.map((d) => (
          <Badge
            key={d}
            tone={pending.has(d) ? "info" : "success"}
            label={`${LABEL[d] ?? d}: ${pending.has(d) ? "downloading" : "ready"}`}
          />
        ))}
        <Text variant="caption" tone="muted" testID="bootstrap-progress">
          {DATASETS.length - pending.size} of {DATASETS.length} ready
        </Text>
      </Screen>
    </Gate>
  );
}
