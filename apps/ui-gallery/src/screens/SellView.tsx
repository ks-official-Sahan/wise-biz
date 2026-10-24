// Static sell screen mock. Local state only: no network, no sync. Demo data throughout.
import { add } from "@wise-biz/money";
import {
  Button,
  Chip,
  MoneyText,
  SearchField,
  Sheet,
  Text,
  createStyles,
  useToast,
} from "@wise-biz/ui";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";

import { Row } from "../components/Row.tsx";
import { addLine, filterProducts, setQty } from "../lib/cart.ts";
import {
  CATEGORIES,
  LOCALE,
  PRODUCTS,
  SEED_CART,
  formatMoney,
  subtotalOf,
  taxOf,
} from "../lib/demo.ts";
import { sellLayoutFor } from "../lib/layout.ts";

import { CartLineRow } from "./sell/CartLineRow.tsx";
import { ProductTile } from "./sell/ProductTile.tsx";

import type { CartLine, CategoryKey } from "../lib/demo.ts";
import type { SellLayout } from "../lib/layout.ts";

const useStyles = createStyles((t) => ({
  fill: { flex: 1, minHeight: 0 },
  pane: { flex: 1, minHeight: 0, padding: t.space[4], gap: t.space[3] },
  paneContent: { padding: t.space[4], gap: t.space[2] },
  topBar: { padding: t.space[4], gap: t.space[3] },
  divider: { borderColor: t.color.border, borderTopWidth: StyleSheet.hairlineWidth },
  splitLeft: { borderRightWidth: StyleSheet.hairlineWidth, borderColor: t.color.border },
  totals: {
    gap: t.space[2],
    padding: t.space[4],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: t.color.border,
    backgroundColor: t.color.surface,
  },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  breakdown: { gap: t.space[1], paddingTop: t.space[2] },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  payBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: t.space[3],
    padding: t.space[4],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: t.color.border,
    backgroundColor: t.color.surface,
  },
  payBarStacked: {
    gap: t.space[2],
    padding: t.space[4],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: t.color.border,
    backgroundColor: t.color.surface,
  },
  payTotal: { flex: 1, minHeight: 0 },
  emptyCart: { paddingVertical: t.space[6], gap: t.space[2] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: t.space[2] },
  sheetBody: { gap: t.space[3], paddingTop: t.space[3] },
}));

interface ProductPaneProps {
  readonly layout: SellLayout;
  /** Text in the search field (updates on every key). */
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  /** Debounced search text that actually filters the grid. */
  readonly filter: string;
  readonly onSearch: (text: string) => void;
  readonly category: CategoryKey;
  readonly onCategory: (key: CategoryKey) => void;
  readonly onAdd: (productId: string) => void;
  readonly showSearch: boolean;
}

/** Search, category chips, and the product grid. Grid columns come from the layout breakpoint. */
function ProductPane({
  layout,
  value,
  onChangeText,
  filter,
  onSearch,
  category,
  onCategory,
  onAdd,
  showSearch,
}: ProductPaneProps) {
  const styles = useStyles();
  const products = useMemo(() => filterProducts(PRODUCTS, category, filter), [category, filter]);
  const cellWidth = `${String(100 / layout.gridColumns)}%`;
  return (
    <View style={styles.pane}>
      {showSearch ? (
        <SearchField
          label="Search products"
          value={value}
          onChangeText={onChangeText}
          onSearch={onSearch}
          debounceMs={120}
          placeholder="Search or scan"
        />
      ) : null}
      <View role="radiogroup" aria-label="Category" style={styles.chips}>
        {CATEGORIES.map((item) => (
          <Chip
            key={item.key}
            kind="radio"
            label={item.label}
            selected={item.key === category}
            onPress={() => {
              onCategory(item.key);
            }}
          />
        ))}
      </View>
      <ScrollView style={styles.fill} keyboardShouldPersistTaps="handled">
        {products.length === 0 ? (
          <Text variant="body" tone="muted">
            No products match. Clear the search or pick All.
          </Text>
        ) : (
          <View style={styles.grid}>
            {products.map((product) => (
              <View key={product.id} style={{ width: cellWidth }}>
                <ProductTile product={product} onAdd={onAdd} />
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

interface CartPaneProps {
  readonly lines: readonly CartLine[];
  readonly onQty: (productId: string, qty: number) => void;
  readonly onRemove: (productId: string) => void;
  readonly onPay: () => void;
  /** Phone and tablet keep the total in a pay bar; tablet also lists subtotal and tax under the lines. */
  readonly variant: "phone" | "tablet" | "desktop";
}

/** Cart list, then totals and the primary pay action (or the sticky bar on phones). */
function CartPane({ lines, onQty, onRemove, onPay, variant }: CartPaneProps) {
  const styles = useStyles();
  const compact = variant !== "desktop";
  const subtotal = useMemo(() => subtotalOf(lines), [lines]);
  const tax = useMemo(() => taxOf(subtotal), [subtotal]);
  const total = useMemo(() => add(subtotal, tax), [subtotal, tax]);
  const payLabel = `Pay ${formatMoney(total)}`;
  return (
    <View style={styles.fill}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.paneContent}
        keyboardShouldPersistTaps="handled"
      >
        {lines.length === 0 ? (
          <View style={styles.emptyCart}>
            <Text variant="heading">Cart is empty</Text>
            <Text variant="body" tone="muted">
              Pick a product or scan a barcode to add the first line.
            </Text>
          </View>
        ) : (
          lines.map((line) => (
            <CartLineRow
              key={line.product.id}
              line={line}
              stacked={variant === "phone"}
              onQty={onQty}
              onRemove={onRemove}
            />
          ))
        )}
        {variant === "tablet" && lines.length > 0 ? (
          <View style={styles.breakdown}>
            <View style={styles.totalRow}>
              <Text variant="body" tone="muted">
                Subtotal
              </Text>
              <MoneyText value={subtotal} locale={LOCALE} size="sm" />
            </View>
            <View style={styles.totalRow}>
              <Text variant="body" tone="muted">
                Tax 18%
              </Text>
              <MoneyText value={tax} locale={LOCALE} size="sm" />
            </View>
          </View>
        ) : null}
      </ScrollView>
      {compact ? (
        <View style={variant === "phone" ? styles.payBarStacked : styles.payBar}>
          <View style={styles.payTotal}>
            <Text variant="caption" tone="muted">
              Total
            </Text>
            <MoneyText value={total} locale={LOCALE} size={variant === "phone" ? "md" : "lg"} />
          </View>
          <Button label={payLabel} size="lg" fullWidth={variant === "phone"} onPress={onPay} />
        </View>
      ) : (
        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text variant="body" tone="muted">
              Subtotal
            </Text>
            <MoneyText value={subtotal} locale={LOCALE} size="md" />
          </View>
          <View style={styles.totalRow}>
            <Text variant="body" tone="muted">
              Tax 18%
            </Text>
            <MoneyText value={tax} locale={LOCALE} size="md" />
          </View>
          <View style={styles.totalRow}>
            <Text variant="heading">Total</Text>
            <MoneyText value={total} locale={LOCALE} size="total" />
          </View>
          <Button label={payLabel} size="lg" fullWidth onPress={onPay} />
        </View>
      )}
    </View>
  );
}

export function SellView() {
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const layout = useMemo(() => sellLayoutFor(width), [width]);
  const toast = useToast();

  const [lines, setLines] = useState<readonly CartLine[]>(SEED_CART);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<CategoryKey>("all");
  const [sheetOpen, setSheetOpen] = useState(false);

  const onAdd = useCallback((productId: string) => {
    const product = PRODUCTS.find((item) => item.id === productId);
    if (product !== undefined) setLines((current) => addLine(current, product));
  }, []);
  const onQty = useCallback((productId: string, qty: number) => {
    setLines((current) => setQty(current, productId, qty));
  }, []);
  const onRemove = useCallback((productId: string) => {
    setLines((current) => current.filter((line) => line.product.id !== productId));
  }, []);
  const onPay = useCallback(() => {
    toast.show({ message: "Gallery only. Nothing was charged.", tone: "info" });
  }, [toast]);
  const onSearch = useCallback((text: string) => {
    setFilter(text);
  }, []);
  const openSheet = useCallback(() => {
    setSheetOpen(true);
  }, []);
  const closeSheet = useCallback(() => {
    setSheetOpen(false);
  }, []);

  if (layout.kind === "phone") {
    return (
      <View style={styles.fill}>
        <View style={styles.topBar}>
          <SearchField
            label="Search products"
            value={query}
            onChangeText={setQuery}
            onSearch={onSearch}
            debounceMs={120}
            placeholder="Search or scan"
          />
          <Row>
            <Button label="Browse products" variant="secondary" onPress={openSheet} />
          </Row>
        </View>
        <CartPane lines={lines} onQty={onQty} onRemove={onRemove} onPay={onPay} variant="phone" />
        <Sheet visible={sheetOpen} title="Add products" onClose={closeSheet}>
          <View style={styles.sheetBody}>
            <ProductPane
              layout={layout}
              value={query}
              onChangeText={setQuery}
              filter={filter}
              onSearch={onSearch}
              category={category}
              onCategory={setCategory}
              onAdd={onAdd}
              showSearch={false}
            />
          </View>
        </Sheet>
      </View>
    );
  }

  if (layout.kind === "tablet") {
    return (
      <View style={styles.fill}>
        <View style={[styles.fill, { flex: 4 }]}>
          <CartPane
            lines={lines}
            onQty={onQty}
            onRemove={onRemove}
            onPay={onPay}
            variant="tablet"
          />
        </View>
        <View style={[styles.fill, { flex: 6 }, styles.divider]}>
          <ProductPane
            layout={layout}
            value={query}
            onChangeText={setQuery}
            filter={filter}
            onSearch={onSearch}
            category={category}
            onCategory={setCategory}
            onAdd={onAdd}
            showSearch
          />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.fill, { flexDirection: "row" }]}>
      <View style={[styles.fill, { flex: 6 }, styles.splitLeft]}>
        <ProductPane
          layout={layout}
          value={query}
          onChangeText={setQuery}
          filter={filter}
          onSearch={onSearch}
          category={category}
          onCategory={setCategory}
          onAdd={onAdd}
          showSearch
        />
      </View>
      <View style={[styles.fill, { flex: 4 }]}>
        <CartPane lines={lines} onQty={onQty} onRemove={onRemove} onPay={onPay} variant="desktop" />
      </View>
    </View>
  );
}
