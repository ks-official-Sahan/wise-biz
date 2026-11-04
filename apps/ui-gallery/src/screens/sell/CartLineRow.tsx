import { IconTrash } from "@tabler/icons-react-native";
import { multiply } from "@wise-biz/money";
import { IconButton, MoneyText, QuantityStepper, Text, createStyles } from "@wise-biz/ui";
import { memo, useCallback } from "react";
import { View } from "react-native";

import { MAX_QTY } from "../../lib/cart.ts";
import { LOCALE, formatMoney } from "../../lib/demo.ts";

import type { CartLine } from "../../lib/demo.ts";

const useStyles = createStyles((t) => ({
  // Wide: one row, name on the left, controls and total on the right, all centred on one line.
  row: { flexDirection: "row", alignItems: "center", gap: t.space[2], paddingVertical: t.space[2] },
  // Phone: name on the first row, controls on a second row, right aligned.
  stackedRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: t.space[1],
    paddingVertical: t.space[2],
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: t.space[2],
  },
  name: { flex: 1, minWidth: 0, gap: t.space[1] },
  // Wide: fixed width so totals line up in a column. Phone: the total is body size (md does not fit beside the stepper at 390 dp).
  amount: { alignItems: "flex-end", flexShrink: 0 },
  amountWide: { minWidth: 128 },
}));

export interface CartLineRowProps {
  readonly line: CartLine;
  readonly stacked: boolean;
  readonly onQty: (productId: string, qty: number) => void;
  readonly onRemove: (productId: string) => void;
}

/** One cart line. Memoized so a quantity change only re-renders that row. */
export const CartLineRow = memo(function CartLineRow({
  line,
  stacked,
  onQty,
  onRemove,
}: CartLineRowProps) {
  const styles = useStyles();
  const { product, qty } = line;
  const handleQty = useCallback(
    (next: number) => {
      onQty(product.id, next);
    },
    [onQty, product.id],
  );
  const handleRemove = useCallback(() => {
    onRemove(product.id);
  }, [onRemove, product.id]);

  const name = (
    <View style={styles.name}>
      <Text variant="body" numberOfLines={2}>
        {product.name}
      </Text>
      <Text variant="caption" tone="muted" numeric>
        {`${formatMoney(product.price)} each`}
      </Text>
    </View>
  );

  const controls = (
    <>
      <QuantityStepper
        value={qty}
        min={1}
        max={MAX_QTY}
        onChange={handleQty}
        label={`Quantity of ${product.name}`}
      />
      <View style={[styles.amount, stacked ? undefined : styles.amountWide]}>
        <MoneyText
          value={multiply(product.price, qty)}
          locale={LOCALE}
          size={stacked ? "sm" : "md"}
        />
      </View>
      <IconButton
        icon={IconTrash}
        accessibilityLabel={`Remove ${product.name}`}
        onPress={handleRemove}
        variant="ghost"
      />
    </>
  );

  if (stacked) {
    return (
      <View style={styles.stackedRow}>
        {name}
        <View style={styles.controls}>{controls}</View>
      </View>
    );
  }
  return (
    <View style={styles.row}>
      {name}
      {controls}
    </View>
  );
});
