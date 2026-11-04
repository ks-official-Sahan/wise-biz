// Demo data: Ceylon cafe orders, terminal status and LKR totals.
import {
  IconAlertTriangle,
  IconCheck,
  IconCloudOff,
  IconCoffee,
  IconReceipt,
} from "@tabler/icons-react-native";
import { money } from "@wise-biz/money";
import {
  Badge,
  Card,
  Divider,
  ListRow,
  MoneyText,
  Skeleton,
  StatusDot,
  Tabs,
  Text,
  createStyles,
} from "@wise-biz/ui";
import { useState } from "react";
import { View } from "react-native";

import { Column, Row } from "../../components/Row.tsx";
import { Section } from "../../components/Section.tsx";
import { LOCALE } from "../../lib/demo.ts";

const useStyles = createStyles((t) => ({
  stack: { gap: t.space[2], alignSelf: "stretch" as const },
  card: { alignSelf: "stretch" as const, gap: t.space[2] },
}));

const PERIOD_ITEMS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
] as const;

const PERIOD_TEXT: Readonly<Record<string, string>> = {
  today: "today",
  week: "this week",
  month: "this month",
};

export function DataSections() {
  const styles = useStyles();
  const [period, setPeriod] = useState<string>("today");

  return (
    <>
      <Section
        title="Badges"
        purpose="One tone per status. Each badge also has a word and an icon."
      >
        <Row>
          <Badge tone="success" label="Synced" icon={IconCheck} />
          <Badge tone="info" label="3 orders queued" icon={IconReceipt} />
          <Badge tone="warning" label="Low stock: 4 left" icon={IconAlertTriangle} />
          <Badge tone="danger" label="Offline" icon={IconCloudOff} />
        </Row>
      </Section>
      <Section
        title="Cards"
        purpose="Surface step and a hairline border. A pressable card gets a press state and a focus ring."
      >
        <View style={styles.card}>
          <Card>
            <Text variant="heading">Kade Cafe, Galle Road</Text>
            <Text variant="caption" tone="muted">
              Demo data. Shift opened 07:30.
            </Text>
          </Card>
          <Card onPress={() => undefined} accessibilityLabel="Open order 1042, three lines">
            <Text variant="label">Order 1042</Text>
            <Text variant="caption" tone="muted">
              3 lines, paid by card
            </Text>
          </Card>
        </View>
      </Section>
      <Section
        title="List rows"
        purpose="Virtualized lists use the same row. The title is the accessible name of a pressable row."
      >
        <View style={styles.stack}>
          <ListRow
            title="Ceylon milk tea"
            subtitle="2 x LKR 350.00"
            leading={<IconCoffee aria-hidden />}
            trailing={<MoneyText value={money(70000, "LKR")} locale={LOCALE} size="sm" />}
            onPress={() => undefined}
            divider
          />
          <ListRow
            title="Chicken kottu"
            subtitle="1 x LKR 1,250.00"
            trailing={<MoneyText value={money(125000, "LKR")} locale={LOCALE} size="sm" />}
            divider
          />
          <ListRow
            title="Watalappan"
            subtitle="Dessert, no nuts"
            trailing={<Text variant="label">LKR 420.00</Text>}
          />
        </View>
      </Section>
      <Section
        title="Tabs"
        purpose="Arrow keys move between tabs on web. The selected tab is announced."
      >
        <Tabs
          accessibilityLabel="Sales period"
          items={PERIOD_ITEMS}
          value={period}
          onChange={setPeriod}
        />
        <Text variant="body">{`Showing sales for ${PERIOD_TEXT[period] ?? "today"}.`}</Text>
      </Section>
      <Section
        title="Skeleton"
        purpose="Loading state with the final shape. Pulses only when motion is allowed."
      >
        <View style={styles.stack} role="status" aria-busy accessibilityLabel="Loading orders">
          <Skeleton width="100%" height={48} radius="card" />
          <Skeleton width="72%" height={16} />
          <Skeleton width="48%" height={16} />
        </View>
      </Section>
      <Section
        title="Divider and status"
        purpose="Status uses a dot plus a label. The label carries the meaning."
      >
        <Column>
          <StatusDot tone="success" label="Terminal 1 online" />
          <StatusDot tone="warning" label="Receipt paper low" />
          <StatusDot tone="info" label="Sync running" />
          <StatusDot tone="danger" label="Card reader disconnected" />
        </Column>
        <Divider />
      </Section>
    </>
  );
}
