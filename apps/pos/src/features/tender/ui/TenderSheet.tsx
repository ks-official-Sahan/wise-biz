import { money } from "@wise-biz/money";
import {
  Badge,
  Button,
  Chip,
  ListRow,
  MoneyText,
  NumberPad,
  Sheet,
  Text,
  createStyles,
} from "@wise-biz/ui";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { formatMinor } from "../../sell/model/view.ts";
import { parseMajor, suggestedAmounts } from "../model/tender.ts";

import type { TenderState } from "../model/session.ts";

const useStyles = createStyles((t) => ({
  body: { padding: t.space[4], gap: t.space[3], maxHeight: 640 },
  due: { alignItems: "center", gap: t.space[1] },
  row: { flexDirection: "row", flexWrap: "wrap", gap: t.space[2] },
  entry: { alignItems: "flex-end" },
  done: { alignItems: "center", gap: t.space[3], paddingVertical: t.space[4] },
}));

export interface TenderSheetProps {
  readonly visible: boolean;
  readonly state: TenderState;
  readonly payableMinor: number;
  readonly currency: string;
  readonly locale: string;
  /** False hides the card button (no terminal set up, or offline without store and forward). */
  readonly cardAvailable: boolean;
  readonly onCash: (receivedMinor: number) => void;
  readonly onCard: () => void;
  readonly onCancelCard: () => void;
  readonly onRemove: (id: string) => void;
  readonly onReprint: () => void;
  readonly onRetrySave: () => void;
  readonly onClearCardBlock: () => void;
  readonly onClose: () => void;
  readonly onNewSale: () => void;
}

const KIND = {
  cash: "Cash",
  card: "Card",
  voucher: "Voucher",
  store_credit: "Store credit",
} as const;

/**
 * Tender sheet: what is owed, quick cash amounts, a keypad for any amount, card, and the tenders so far. After the sale
 * is saved it turns into the change screen (change is the biggest thing on it) with the print state.
 */
export function TenderSheet(p: TenderSheetProps) {
  const s = useStyles();
  const [entry, setEntry] = useState("");
  const { state } = p;
  const owed = state.remainingMinor;
  const money_ = (minor: number) => money(minor, p.currency);
  const typed = entry === "" ? undefined : parseMajor(entry, p.currency);

  const submitEntry = () => {
    if (typed !== undefined && typed > 0) {
      p.onCash(typed);
      setEntry("");
    }
  };

  if (state.phase === "done") {
    return (
      <Sheet visible={p.visible} title="Sale complete" onClose={p.onNewSale} testID="tender-sheet">
        <View style={s.done}>
          {state.changeMinor > 0 ? (
            <>
              <Text variant="heading">Change due</Text>
              <View testID="tender-change">
                <MoneyText
                  value={money_(state.changeMinor)}
                  locale={p.locale}
                  size="total"
                  emphasis
                />
              </View>
            </>
          ) : (
            <Text variant="heading">Paid in full</Text>
          )}
          {state.printed === "failed" ? (
            <View role="alert" style={s.done}>
              <Text tone="danger" testID="tender-print-failed">
                The receipt did not print. The sale is saved.
              </Text>
              <Button
                label="Print again"
                variant="secondary"
                onPress={p.onReprint}
                testID="tender-reprint"
              />
            </View>
          ) : state.printed === "none" ? (
            <Text tone="muted" testID="tender-no-printer">
              No printer is set up on this terminal.
            </Text>
          ) : (
            <Text tone="muted">{state.printed === "ok" ? "Receipt printed." : "Printing…"}</Text>
          )}
          <Button
            label="New sale"
            onPress={p.onNewSale}
            fullWidth
            size="lg"
            testID="tender-new-sale"
          />
        </View>
      </Sheet>
    );
  }

  const busy = state.phase !== "tendering";
  // Escape, back and the backdrop must not abandon a card prompt, a save in progress or an approved card payment.
  const canClose = state.phase === "tendering" && !state.tenders.some((t) => t.kind === "card");
  const close = canClose ? p.onClose : () => undefined;
  return (
    <Sheet visible={p.visible} title="Payment" onClose={close} testID="tender-sheet">
      <ScrollView contentContainerStyle={s.body}>
        <View style={s.due}>
          <Text tone="muted">Amount due</Text>
          <View testID="tender-due">
            <MoneyText value={money_(owed)} locale={p.locale} size="total" emphasis />
          </View>
          {owed < p.payableMinor ? (
            <Text
              variant="caption"
              tone="muted"
            >{`Total ${formatMinor(p.payableMinor, p.currency, p.locale)}`}</Text>
          ) : null}
        </View>

        {state.message === undefined ? null : (
          <View role="alert">
            <Text
              tone={state.message.tone === "danger" ? "danger" : "muted"}
              testID="tender-message"
            >
              {state.message.text}
            </Text>
          </View>
        )}

        {state.phase === "card" ? (
          <View style={s.done}>
            <Badge
              tone="info"
              label={
                state.cardState === "pending" ? "Waiting for the card" : "Starting the terminal"
              }
            />
            <Button
              label="Cancel card"
              variant="secondary"
              onPress={p.onCancelCard}
              testID="tender-cancel-card"
            />
          </View>
        ) : (
          <>
            <View style={s.row}>
              {suggestedAmounts(owed, p.currency).map((a, i) => (
                <Chip
                  key={a}
                  label={
                    a === owed
                      ? `Exact ${formatMinor(a, p.currency, p.locale)}`
                      : formatMinor(a, p.currency, p.locale)
                  }
                  selected={false}
                  onPress={() => {
                    p.onCash(a);
                  }}
                  testID={`tender-suggest-${String(i)}`}
                />
              ))}
            </View>
            <View style={s.entry}>
              <Text variant="title" numeric testID="tender-entry">
                {entry === "" ? "0" : entry}
              </Text>
            </View>
            <NumberPad
              allowDecimal
              onKey={(k) => {
                if (k === "delete") setEntry((e) => e.slice(0, -1));
                else if (k === "." && entry.includes(".")) return;
                else if (entry.length < 12) setEntry((e) => e + k);
              }}
              onSubmit={submitEntry}
              testID="tender-pad"
            />
            <Button
              label="Take cash"
              onPress={submitEntry}
              disabled={busy || typed === undefined || typed <= 0 || state.needsSave === true}
              fullWidth
              testID="tender-cash"
            />
            {state.needsSave === true ? (
              <Button
                label="Save sale"
                onPress={p.onRetrySave}
                fullWidth
                testID="tender-retry-save"
              />
            ) : null}
            {state.cardBlocked === true ? (
              <Button
                label="I checked the terminal"
                variant="secondary"
                onPress={p.onClearCardBlock}
                fullWidth
                testID="tender-clear-block"
              />
            ) : null}
            {p.cardAvailable && state.cardBlocked !== true ? (
              <Button
                label="Pay by card"
                variant="secondary"
                onPress={p.onCard}
                disabled={busy}
                fullWidth
                testID="tender-card"
              />
            ) : null}
          </>
        )}

        {state.tenders.length === 0 ? null : (
          <View>
            <Text variant="label" tone="muted">
              Paid so far
            </Text>
            {state.tenders.map((t) => (
              <ListRow
                key={t.id}
                title={
                  t.card?.last4 === undefined ? KIND[t.kind] : `${KIND[t.kind]} ****${t.card.last4}`
                }
                trailing={<MoneyText value={money_(t.amountMinor)} locale={p.locale} size="sm" />}
                {...(t.kind === "card"
                  ? {}
                  : {
                      onPress: () => {
                        p.onRemove(t.id);
                      },
                    })}
              />
            ))}
          </View>
        )}
        <Button
          label="Back to cart"
          variant="ghost"
          onPress={close}
          fullWidth
          disabled={
            state.phase === "card" ||
            state.phase === "committing" ||
            state.tenders.some((t) => t.kind === "card")
          }
        />
      </ScrollView>
    </Sheet>
  );
}
