// Demo data: LKR amounts for a Sri Lankan cafe.
import { money } from "@wise-biz/money";
import { MoneyText, Text, createStyles } from "@wise-biz/ui";
import { View } from "react-native";

import { Column, Row } from "../../components/Row.tsx";
import { Section } from "../../components/Section.tsx";
import { LOCALE } from "../../lib/demo.ts";

const VARIANTS = ["display", "title", "heading", "body", "label", "caption"] as const;
const TONES = ["default", "muted", "accent", "danger", "success", "warning"] as const;
const SIZES = ["sm", "md", "lg", "total"] as const;

const useStyles = createStyles(() => ({ fill: { alignSelf: "stretch" as const } }));

export function TypographySections() {
  const styles = useStyles();
  return (
    <>
      <Section
        title="Text variants"
        purpose="Six type steps, from display to caption. Body is the reading size at the counter."
      >
        <View style={styles.fill}>
          {VARIANTS.map((variant) => (
            <Text key={variant} variant={variant}>
              {`${variant}: Ceylon milk tea, 2 cups`}
            </Text>
          ))}
        </View>
      </Section>
      <Section
        title="Text tones"
        purpose="Tone carries emphasis; status tones also carry a word or icon, never color alone."
      >
        <Row>
          {TONES.map((tone) => (
            <Text key={tone} tone={tone} variant="label">
              {tone}
            </Text>
          ))}
        </Row>
      </Section>
      <Section
        title="Money sizes"
        purpose="MoneyText uses tabular figures. The total size is for the amount due."
      >
        <Row>
          {SIZES.map((size) => (
            <Column key={size}>
              <MoneyText value={money(139660, "LKR")} locale={LOCALE} size={size} />
              <Text variant="caption" tone="muted">
                {size}
              </Text>
            </Column>
          ))}
          <Column>
            <MoneyText value={money(42660, "LKR")} locale={LOCALE} size="md" emphasis />
            <Text variant="caption" tone="muted">
              emphasis
            </Text>
          </Column>
        </Row>
      </Section>
    </>
  );
}
