import {
  IconBarcode,
  IconLayoutGrid,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
  IconUser,
} from "@tabler/icons-react-native";
import { format as formatMoney, money } from "@wise-biz/money";
import {
  Badge,
  Button,
  Card,
  Divider,
  IconButton,
  MoneyText,
  QuantityStepper,
  SearchField,
  Tabs,
  Text,
  createStyles,
} from "@wise-biz/ui";
import { ScrollView, View, useWindowDimensions } from "react-native";

import { layoutClass } from "./types.ts";

import type { SellLine, SellViewProps } from "./types.ts";

const useStyles = createStyles((t) => ({
  root: { flex: 1, backgroundColor: t.color.canvas },
  row: { flex: 1, flexDirection: "row" },
  rowReverse: { flex: 1, flexDirection: "row-reverse" },
  col: { flex: 1 },
  pane: { padding: t.space[4], gap: t.space[3] },
  catalog: { flex: 3 },
  cart: {
    flex: 2,
    backgroundColor: t.color.surface,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: t.color.border,
  },
  header: { flexDirection: "row", alignItems: "center", gap: t.space[2] },
  grow: { flex: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: t.space[3] },
  tile: {
    minWidth: 132,
    flexGrow: 1,
    flexBasis: 132,
    minHeight: 84,
    justifyContent: "space-between",
  },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: t.space[3],
    paddingVertical: t.space[2],
  },
  lineStack: { gap: t.space[2], paddingVertical: t.space[3] },
  lineControls: { flexDirection: "row", alignItems: "center", gap: t.space[2] },
  lineBody: { flex: 1, gap: t.space[1] },
  totals: { padding: t.space[4], gap: t.space[2] },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  payBar: {
    padding: t.space[4],
    gap: t.space[2],
    borderTopWidth: 1,
    borderColor: t.color.border,
    backgroundColor: t.color.surfaceRaised,
  },
  actions: { flexDirection: "row", gap: t.space[2], alignItems: "center" },
  empty: { padding: t.space[6], alignItems: "center", gap: t.space[2] },
}));

function Header(p: SellViewProps) {
  const s = useStyles();
  const { width } = useWindowDimensions();
  return (
    <View style={s.header}>
      <View style={s.grow}>
        <SearchField
          label="Search products or scan"
          placeholder="Scan or search"
          value={p.query}
          onChangeText={p.onQuery}
          onSearch={p.onSearch}
          debounceMs={120}
          testID="sell-search"
        />
      </View>
      {width < 600 && p.onShowCatalog !== undefined ? (
        <IconButton
          icon={IconLayoutGrid}
          accessibilityLabel="Browse products"
          onPress={p.onShowCatalog}
          variant="secondary"
          testID="sell-catalog"
        />
      ) : null}
      {p.onShowParked !== undefined && (p.parkedCount ?? 0) > 0 ? (
        <IconButton
          icon={IconPlayerPlay}
          accessibilityLabel={`Parked sales (${String(p.parkedCount)})`}
          onPress={p.onShowParked}
          variant="secondary"
          testID="sell-parked"
        />
      ) : null}
      <IconButton
        icon={IconBarcode}
        accessibilityLabel="Scan with camera"
        onPress={p.onScan}
        variant="secondary"
        testID="sell-scan"
      />
    </View>
  );
}

export function Catalog(p: SellViewProps) {
  const s = useStyles();
  return (
    <View style={s.pane}>
      <Tabs
        items={p.categories}
        value={p.category}
        onChange={p.onCategory}
        accessibilityLabel="Categories"
      />
      <View style={s.grid}>
        {p.quickItems.map((q) => (
          <Card
            key={q.id}
            style={s.tile}
            accessibilityLabel={`Add ${q.name}, ${formatMoney(money(q.priceMinor, p.totals.currency), p.locale)}`}
            onPress={() => {
              p.onAddQuick(q.id);
            }}
          >
            <Text variant="label" numberOfLines={2}>
              {q.name}
            </Text>
            <MoneyText
              value={money(q.priceMinor, p.totals.currency)}
              locale={p.locale}
              size="sm"
              tone="muted"
            />
          </Card>
        ))}
      </View>
    </View>
  );
}

function LineRow({ line, p }: { line: SellLine; p: SellViewProps }) {
  const s = useStyles();
  const { width } = useWindowDimensions();
  const compact = width < 600;
  const controls = (
    <>
      {Number.isInteger(line.qty) ? (
        <QuantityStepper
          value={line.qty}
          min={1}
          max={999}
          label={`Quantity of ${line.name}`}
          onChange={(n) => {
            p.onQty(line.id, n);
          }}
        />
      ) : (
        // Weighed goods keep their decimal quantity: the stepper would round it.
        <Text variant="label" numeric>{`${String(line.qty)} kg`}</Text>
      )}
      {compact ? <View style={s.grow} /> : null}
      <MoneyText
        value={money(line.lineTotalMinor, p.totals.currency)}
        locale={p.locale}
        size="md"
      />
      <IconButton
        icon={IconTrash}
        accessibilityLabel={`Remove ${line.name}`}
        onPress={() => {
          p.onRemove(line.id);
        }}
      />
    </>
  );
  const info = (
    <View style={s.lineBody}>
      <Text variant="body" numberOfLines={2}>
        {line.name}
      </Text>
      <Text variant="caption" tone="muted">
        {line.detail}
      </Text>
      {line.discountMinor === undefined || line.discountMinor === 0 ? null : (
        <Badge tone="success" label="Promotion applied" />
      )}
    </View>
  );
  if (compact) {
    return (
      <View style={s.lineStack}>
        {info}
        <View style={s.lineControls}>{controls}</View>
      </View>
    );
  }
  return (
    <View style={s.line}>
      {info}
      {controls}
    </View>
  );
}

function CartPane(p: SellViewProps) {
  const s = useStyles();
  const { totals: t } = p;
  return (
    <View style={s.col}>
      <ScrollView contentContainerStyle={s.pane} testID="cart-lines">
        {p.lines.length === 0 ? (
          <View style={s.empty}>
            <Text variant="heading">Cart is empty</Text>
            <Text tone="muted">Scan an item or tap one to start a sale.</Text>
          </View>
        ) : (
          p.lines.map((l, i) => (
            <View key={l.id}>
              {i > 0 ? <Divider /> : null}
              <LineRow line={l} p={p} />
            </View>
          ))
        )}
      </ScrollView>
      <View style={s.totals}>
        <View style={s.totalRow}>
          <Text tone="muted">{`Subtotal (${String(t.itemCount)} items)`}</Text>
          <MoneyText value={money(t.subtotalMinor, t.currency)} locale={p.locale} size="sm" />
        </View>
        {t.discountMinor === 0 ? null : (
          <View style={s.totalRow}>
            <Text tone="success">Discounts</Text>
            <MoneyText
              value={money(-t.discountMinor, t.currency)}
              locale={p.locale}
              size="sm"
              tone="success"
            />
          </View>
        )}
        <View style={s.totalRow}>
          <Text tone="muted">Tax</Text>
          <MoneyText value={money(t.taxMinor, t.currency)} locale={p.locale} size="sm" />
        </View>
      </View>
      <View style={s.payBar}>
        <View style={s.totalRow}>
          <Text variant="heading">Total</Text>
          <MoneyText
            value={money(t.totalMinor, t.currency)}
            locale={p.locale}
            size="total"
            emphasis
          />
        </View>
        <View style={s.actions}>
          <IconButton
            icon={IconPlayerPause}
            accessibilityLabel="Park sale"
            onPress={p.onPark}
            variant="secondary"
          />
          <IconButton
            icon={IconUser}
            accessibilityLabel="Attach customer"
            onPress={p.onCustomer}
            variant="secondary"
          />
          <View style={s.grow}>
            <Button
              label="Pay"
              onPress={p.onPay}
              disabled={p.lines.length === 0}
              fullWidth
              size="lg"
              testID="sell-pay"
            />
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * The checkout screen by device class (docs/design/ux.md): phone is one column with a sticky pay bar; tablet portrait
 * stacks cart over the grid; landscape and desktop are two panes (catalog 60%, cart 40%), mirrored when left-handed.
 */
export function SellView(p: SellViewProps) {
  const s = useStyles();
  const { width, height } = useWindowDimensions();
  const cls = layoutClass(width, height);

  if (cls === "phone") {
    return (
      <View style={s.root} testID="sell-phone">
        <View style={s.pane}>
          <Header {...p} />
        </View>
        <CartPane {...p} />
      </View>
    );
  }
  if (cls === "tabletPortrait") {
    return (
      <View style={s.root} testID="sell-tablet-portrait">
        <View style={s.pane}>
          <Header {...p} />
        </View>
        <View style={{ flex: 2 }}>
          <CartPane {...p} />
        </View>
        <ScrollView style={{ flex: 2 }}>
          <Catalog {...p} />
        </ScrollView>
      </View>
    );
  }
  return (
    <View
      style={p.leftHanded ? s.rowReverse : s.row}
      testID={cls === "desktop" ? "sell-desktop" : "sell-tablet-landscape"}
    >
      <View style={[s.root, s.catalog]}>
        <View style={s.pane}>
          <Header {...p} />
        </View>
        <ScrollView>
          <Catalog {...p} />
        </ScrollView>
      </View>
      <View style={s.cart}>
        <CartPane {...p} />
      </View>
    </View>
  );
}
