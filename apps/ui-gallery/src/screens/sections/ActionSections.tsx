// Demo data: the cart total is the same LKR figure the sell screen shows.
import { IconCreditCard, IconMinus, IconPlus, IconTrash } from "@tabler/icons-react-native";
import { Button, IconButton, createStyles } from "@wise-biz/ui";
import { useCallback } from "react";
import { View } from "react-native";

import { Row } from "../../components/Row.tsx";
import { Section } from "../../components/Section.tsx";
import { SEED_CART, formatMoney, subtotalOf, taxOf } from "../../lib/demo.ts";

const VARIANTS = ["primary", "secondary", "ghost", "danger"] as const;
const SIZES = ["md", "lg"] as const;

const DEMO_TOTAL = formatMoney(subtotalOf(SEED_CART));

const useStyles = createStyles((t) => ({
  fill: { alignSelf: "stretch" as const, gap: t.space[3] },
}));

export function ActionSections() {
  const styles = useStyles();
  // Demo only: a promise-returning press shows how the double-submit guard holds the button.
  const slowSave = useCallback(() => new Promise<void>((resolve) => setTimeout(resolve, 900)), []);
  // Demo only: the gallery does not change the cart from these buttons.
  const remove = useCallback(() => undefined, []);

  return (
    <>
      <Section
        title="Buttons"
        purpose="Four variants in two sizes. Lg is for primary checkout actions (56 dp touch target)."
      >
        <View style={styles.fill}>
          {SIZES.map((size) => (
            <Row key={size}>
              {VARIANTS.map((variant) => (
                <Button
                  key={`${variant}-${size}`}
                  label={
                    variant === "danger"
                      ? "Void line"
                      : variant === "ghost"
                        ? "Park sale"
                        : "Save order"
                  }
                  variant={variant}
                  size={size}
                  onPress={slowSave}
                />
              ))}
            </Row>
          ))}
        </View>
      </Section>
      <Section
        title="Button states"
        purpose="Disabled, loading, and with an icon. Loading blocks presses while the work runs."
      >
        <Row>
          <Button label="Save order" disabled onPress={slowSave} />
          <Button label="Saving order" loading onPress={slowSave} />
          <Button label={`Pay ${DEMO_TOTAL}`} size="lg" icon={IconCreditCard} onPress={slowSave} />
          <Button label="Add line" variant="secondary" icon={IconPlus} onPress={slowSave} />
          <Button
            label={`Tax ${formatMoney(taxOf(subtotalOf(SEED_CART)))}`}
            variant="ghost"
            disabled
            onPress={slowSave}
          />
        </Row>
      </Section>
      <Section
        title="Icon buttons"
        purpose="Icon only, so each one carries a full accessible name. Keys turn press scale off."
      >
        <Row>
          <IconButton icon={IconMinus} accessibilityLabel="Decrease quantity" onPress={remove} />
          <IconButton
            icon={IconPlus}
            accessibilityLabel="Increase quantity"
            onPress={remove}
            variant="secondary"
          />
          <IconButton
            icon={IconTrash}
            accessibilityLabel="Remove line"
            onPress={remove}
            variant="secondary"
            pressMotion={false}
          />
          <IconButton
            icon={IconTrash}
            accessibilityLabel="Remove line, unavailable"
            onPress={remove}
            disabled
          />
        </Row>
      </Section>
    </>
  );
}
