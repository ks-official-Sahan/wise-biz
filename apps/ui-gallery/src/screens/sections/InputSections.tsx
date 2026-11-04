// Demo data: sample Sri Lankan cafe lookups and LKR tender amounts.
import { money } from "@wise-biz/money";
import {
  Chip,
  MoneyText,
  NumberPad,
  QuantityStepper,
  SearchField,
  Text,
  TextField,
  createStyles,
} from "@wise-biz/ui";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { Column, Row } from "../../components/Row.tsx";
import { Section } from "../../components/Section.tsx";
import { LOCALE } from "../../lib/demo.ts";

import type { NumberPadKey } from "@wise-biz/ui";

const useStyles = createStyles((t) => ({
  field: { minWidth: 240, flexGrow: 1, flexBasis: 280 },
  keypad: { width: 280 },
  display: { gap: t.space[1] },
}));

function EmptyField() {
  const styles = useStyles();
  const [value, setValue] = useState("");
  return (
    <View style={styles.field}>
      <TextField
        label="Customer name"
        value={value}
        onChangeText={setValue}
        placeholder="Walk-in customer"
      />
    </View>
  );
}

function HelperField() {
  const styles = useStyles();
  const [value, setValue] = useState("");
  return (
    <View style={styles.field}>
      <TextField
        label="Discount"
        value={value}
        onChangeText={setValue}
        helper="Percent off the subtotal, 0 to 100."
        keyboardType="number-pad"
      />
    </View>
  );
}

function ErrorField() {
  const styles = useStyles();
  const [value, setValue] = useState("0");
  return (
    <View style={styles.field}>
      <TextField
        label="Cash tendered"
        value={value}
        onChangeText={setValue}
        error="Enter an amount above LKR 0.00."
        keyboardType="number-pad"
      />
    </View>
  );
}

const PAYMENT_OPTIONS = ["Cash", "Card", "QR"] as const;
const FILTER_OPTIONS = ["Hot", "Cold", "Vegetarian"] as const;

export function InputSections() {
  const styles = useStyles();
  const [query, setQuery] = useState("");
  const [lastSearch, setLastSearch] = useState("none");
  const [tendered, setTendered] = useState("");
  const [quantity, setQuantity] = useState(2);
  const [payment, setPayment] = useState<(typeof PAYMENT_OPTIONS)[number]>("Cash");
  const [filters, setFilters] = useState<readonly string[]>(["Hot"]);

  const onSearch = useCallback((text: string) => {
    setLastSearch(text.length === 0 ? "cleared" : text);
  }, []);

  const onKey = useCallback((key: NumberPadKey) => {
    setTendered((current) => {
      if (key === "delete") return current.slice(0, -1);
      if (key === "." && current.includes(".")) return current;
      return `${current}${key}`.slice(0, 12);
    });
  }, []);

  const toggleFilter = useCallback((label: string) => {
    setFilters((current) =>
      current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
    );
  }, []);

  const tenderedMinor = Math.round(
    Number(tendered === "" || tendered === "." ? 0 : tendered) * 100,
  );

  return (
    <>
      <Section
        title="Text fields"
        purpose="Label is always visible. Helper and error text are linked to the field for screen readers."
      >
        <Row>
          <EmptyField />
          <HelperField />
          <ErrorField />
        </Row>
      </Section>
      <Section
        title="Search"
        purpose="Debounced at 120 ms. Enter or clear runs the search at once."
      >
        <View style={styles.field}>
          <SearchField
            label="Search products"
            value={query}
            onChangeText={setQuery}
            onSearch={onSearch}
            debounceMs={120}
            placeholder="Search or scan"
          />
        </View>
        <Text variant="caption" tone="muted">
          {`Last search: ${lastSearch}`}
        </Text>
      </Section>
      <Section
        title="Number pad"
        purpose="Tender keys. The pad takes no focus, so the scan field keeps it."
      >
        <Row>
          <View style={styles.keypad}>
            <NumberPad onKey={onKey} onSubmit={() => undefined} allowDecimal />
          </View>
          <Column>
            <Text variant="caption" tone="muted">
              Cash tendered
            </Text>
            <Text variant="title" numeric>
              {tendered === "" ? "LKR 0.00" : `LKR ${tendered}`}
            </Text>
            <MoneyText value={money(tenderedMinor, "LKR")} locale={LOCALE} size="lg" />
          </Column>
        </Row>
      </Section>
      <Section
        title="Quantity stepper"
        purpose="Min 1, max 20. The value is announced with its label."
      >
        <QuantityStepper
          value={quantity}
          min={1}
          max={20}
          onChange={setQuantity}
          label="Quantity of Ceylon milk tea"
        />
      </Section>
      <Section
        title="Chips"
        purpose="Radio chips pick one option. Checkbox chips filter. Selected chips also show a check mark."
      >
        <Text variant="label">Payment</Text>
        <Row role="radiogroup" accessibilityLabel="Payment">
          {PAYMENT_OPTIONS.map((option) => (
            <Chip
              key={option}
              kind="radio"
              label={option}
              selected={payment === option}
              onPress={() => {
                setPayment(option);
              }}
            />
          ))}
        </Row>
        <Text variant="label">Filters</Text>
        <Row role="group" accessibilityLabel="Filters">
          {FILTER_OPTIONS.map((option) => (
            <Chip
              key={option}
              label={option}
              selected={filters.includes(option)}
              onPress={() => {
                toggleFilter(option);
              }}
            />
          ))}
        </Row>
      </Section>
    </>
  );
}
