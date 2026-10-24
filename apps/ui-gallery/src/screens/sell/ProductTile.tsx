import { Card, MoneyText, Text, createStyles } from "@wise-biz/ui";
import { memo, useCallback } from "react";
import { View } from "react-native";

import { LOCALE } from "../../lib/demo.ts";

import type { Product } from "../../lib/demo.ts";

const useStyles = createStyles((t) => ({
  cell: { padding: t.space[1] },
  body: { gap: t.space[2], minHeight: t.target.min },
}));

export interface ProductTileProps {
  readonly product: Product;
  readonly onAdd: (productId: string) => void;
}

/** Memoized grid cell. The press callback is keyed by id, so the parent passes one stable handler. */
export const ProductTile = memo(function ProductTile({ product, onAdd }: ProductTileProps) {
  const styles = useStyles();
  const handlePress = useCallback(() => {
    onAdd(product.id);
  }, [onAdd, product.id]);
  return (
    <View style={styles.cell}>
      <Card onPress={handlePress} accessibilityLabel={`Add ${product.name}`}>
        <View style={styles.body}>
          <Text variant="label" numberOfLines={2}>
            {product.name}
          </Text>
          <MoneyText value={product.price} locale={LOCALE} size="sm" />
        </View>
      </Card>
    </View>
  );
});
