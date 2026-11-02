import { uuidv7 } from "@wise-biz/ids";
import { encodeEscPos } from "@wise-biz/receipt";
import { Button, ListRow, Sheet, Text, createStyles, useToast } from "@wise-biz/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useStore } from "react-redux";

import { configuredDevices } from "../../runtime/devices.ts";
import { reportError } from "../../runtime/report.ts";
import { SyncChip } from "../../ui/chrome.tsx";
import { useController } from "../../ui/context.tsx";
import { useAppSelector } from "../../ui/hooks.ts";
import { OperationsSheet } from "../operations/OperationsSheet.tsx";
import { OverrideSheet } from "../overrides/OverrideSheet.tsx";
import { unavailableOverridePort } from "../overrides/port.ts";
import { commitSale, loadLocations } from "../tender/model/commit.ts";
import { receiptJob } from "../tender/model/drawer.ts";
import { buildReceiptDoc } from "../tender/model/receipt-doc.ts";
import { createTenderSession } from "../tender/model/session.ts";
import { TenderSheet } from "../tender/ui/TenderSheet.tsx";

import { toQty4 } from "./model/qty.ts";
import { Catalog, SellView } from "./ui/SellView.tsx";
import { useSell } from "./useSell.ts";
import { useWedgeScanner } from "./useWedge.ts";

import type { EditResult, ParkedSale } from "./model/sell-model.ts";
import type { PosStore } from "../../state/store.ts";
import type { OverridePort } from "../overrides/port.ts";
import type { QuickItem, SellTotals, SellViewProps } from "./ui/types.ts";
import type { TenderSession, TenderState } from "../tender/model/session.ts";

const useStyles = createStyles((t) => ({
  root: { flex: 1 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: t.space[2],
    paddingHorizontal: t.space[4],
    paddingVertical: t.space[2],
    backgroundColor: t.color.surfaceRaised,
    borderBottomWidth: 1,
    borderColor: t.color.border,
  },
  barActions: { flexDirection: "row", gap: t.space[2], alignItems: "center" },
  sheetBody: { padding: t.space[4], gap: t.space[3], maxHeight: 520 },
}));

/** The browser's own connection flag; React Native has none, so it counts as online there (sync reports the rest). */
const browserOnline = (): boolean =>
  (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false;

const RECEIPT_BASE = process.env.EXPO_PUBLIC_RECEIPT_BASE_URL as string | undefined;

const EMPTY_TOTALS = (currency: string): SellTotals => ({
  subtotalMinor: 0,
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 0,
  itemCount: 0,
  currency,
});

type OverrideEdit = Extract<EditResult, { type: "needs_override" }>;

const ageLabel = (ms: number): string => {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 1
    ? "just now"
    : min < 60
      ? `${String(min)} min ago`
      : `${String(Math.round(min / 60))} h ago`;
};

/**
 * The sell screen wired to local data: scanner anywhere on the screen, search, quick keys, cart edits with the undo and
 * supervisor rules, park and resume. Payment (F9) arrives in P1-10; until then Pay says so.
 */
export function SellScreen({
  port = unavailableOverridePort,
  locale = "en-US",
}: {
  port?: OverridePort;
  locale?: string;
}) {
  const s = useStyles();
  const toast = useToast();
  const controller = useController();
  const sell = useSell();
  const store = useStore() as unknown as PosStore;
  const { model, pricing } = sell;
  const leftHanded = useAppSelector((st) => st.ui.leftHanded);
  const operatorId = useAppSelector((st) => st.session.operator?.userId) ?? "";
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [quick, setQuick] = useState<QuickItem[]>([]);
  const [override, setOverride] = useState<OverrideEdit>();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const [parkedOpen, setParkedOpen] = useState(false);
  const [parked, setParked] = useState<ParkedSale[]>([]);
  const [parkedAt, setParkedAt] = useState(0);
  const searchSeq = useRef(0);
  const devices = useMemo(() => configuredDevices(), []);
  const device = useAppSelector((st) => st.session.device);
  const [tender, setTender] = useState<{
    session: TenderSession;
    state: TenderState;
    payable: number;
  }>();

  const say = useCallback(
    (message: string, tone: "info" | "danger" | "success" = "info") => {
      toast.show({ message, tone });
    },
    [toast],
  );

  // Favorites: the first products by id until per-terminal layouts are synced (P1-14).
  const loadQuick = useCallback(
    async (text: string) => {
      if (model === undefined) return;
      const seq = ++searchSeq.current;
      const hits = text.trim() === "" ? await model.favorites(24) : await model.search(text);
      const items: QuickItem[] = [];
      for (const h of hits) {
        const price = await model.ctx.price(h.variantId);
        if (price !== undefined) items.push({ id: h.variantId, name: h.name, priceMinor: price });
      }
      if (seq === searchSeq.current) setQuick(items);
    },
    [model],
  );

  useEffect(() => {
    loadQuick(query).catch(reportError);
    // Re-run when the model appears or prices refresh, not on every keystroke (SearchField debounces onSearch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, sell.rev]);

  const refreshParked = useCallback(() => {
    model
      ?.parked()
      .then((list) => {
        setParked(list);
        setParkedAt(Date.now());
      })
      .catch(reportError);
  }, [model]);
  useEffect(refreshParked, [refreshParked]);

  const onScanned = useCallback(
    (code: string) => {
      if (model === undefined) return;
      // The first key of a burst reaches a focused field before the burst is recognised: clear it.
      setQuery("");
      model
        .scan(code)
        .then((r) => {
          if (r.type === "unknown") {
            // Inline path from ux.md: unknown barcode -> search with it, so the cashier can pick or add a quick item.
            setQuery(code);
            loadQuick(code).catch(reportError);
            say(`Barcode ${code} not found. Search below or add a quick item.`, "danger");
          } else if (r.type === "no_price")
            say(`${r.name} has no price on this terminal.`, "danger");
          else if (r.type === "not_ready") say("Prices are still downloading.", "info");
        })
        .catch(reportError);
    },
    [loadQuick, model, say],
  );
  useWedgeScanner(
    onScanned,
    model !== undefined &&
      override === undefined &&
      !catalogOpen &&
      !opsOpen &&
      !parkedOpen &&
      tender === undefined,
  );

  const edit = (r: EditResult) => {
    if (r.type === "needs_override") setOverride(r);
  };

  const pay = useCallback(() => {
    const p = model?.pricing();
    const deps = controller.sellDeps();
    const ctx = model?.ctx.current;
    if (model === undefined || deps === undefined || ctx === undefined) return;
    if (p?.priced === undefined || p.lines.length === 0) {
      say(p?.error ?? "Add an item first.", "info");
      return;
    }
    const pricing = p;
    // Everything the sale is made of is read now, in one go: an edit while locations load cannot split lines from totals.
    const st = store.getState();
    const lines = st.cart.ids.flatMap((i) => {
      const l = st.cart.entities[i];
      return l === undefined ? [] : [l];
    });
    const { customerId, approvals, note } = st.cart;
    const operator = st.session.operator?.userId ?? "";
    const saleId = uuidv7();
    loadLocations(deps.db)
      .then((locations) => {
        if (!locations.ready) {
          say(
            "This branch has no stock location yet. Wait for the first sync to finish.",
            "danger",
          );
          return;
        }
        const printer = devices.printer;
        const storeName =
          device?.name === undefined || device.name === "" ? "Receipt" : device.name;
        const session = createTenderSession({
          payableMinor: pricing.totals.totalMinor,
          currency: pricing.totals.currency,
          saleRef: saleId,
          adapter: devices.adapter,
          online: browserOnline,
          newId: uuidv7,
          commit: (tenders, id) =>
            commitSale(
              {
                transaction: deps.transaction,
                ctx,
                now: Date.now,
                newId: uuidv7,
                locationOf: locations.locationOf,
                operatorId: operator,
              },
              { pricing, cart: lines, tenders, customerId, approvals, saleId: id },
            ),
          print:
            printer === undefined
              ? undefined
              : (sale, tenders) =>
                  printer.write(
                    receiptJob(
                      encodeEscPos(
                        buildReceiptDoc({
                          sale,
                          pricing,
                          cart: lines,
                          tenders,
                          store: { name: storeName },
                          ...(RECEIPT_BASE === undefined ? {} : { receiptBaseUrl: RECEIPT_BASE }),
                          locale,
                          note,
                        }),
                        { width: 80 },
                      ),
                      tenders,
                    ),
                  ),
          onChange: (state) => {
            setTender((t) => (t?.session !== session ? t : { ...t, state }));
          },
        });
        setTender({ session, state: session.state(), payable: pricing.totals.totalMinor });
      })
      .catch(reportError);
  }, [controller, device, devices, locale, model, say, store]);

  const view: SellViewProps = {
    lines: pricing?.lines ?? [],
    totals: pricing?.totals ?? EMPTY_TOTALS(sell.currency ?? "USD"),
    categories: [{ key: "all", label: "All products" }],
    category,
    quickItems: quick,
    query,
    leftHanded,
    locale,
    onQuery: setQuery,
    onSearch: (text: string) => {
      loadQuick(text).catch(reportError);
    },
    onCategory: setCategory,
    onAddQuick: (id: string) => {
      model
        ?.addVariant(id, "1")
        .then((r) => {
          if (r.type === "no_price") say(`${r.name} has no price on this terminal.`, "danger");
        })
        .catch(reportError);
      setCatalogOpen(false);
    },
    onQty: (id: string, qty: number) => {
      if (model !== undefined && toQty4(String(qty)) !== undefined)
        edit(model.changeQty(id, String(qty)));
    },
    onRemove: (id: string) => {
      if (model !== undefined) edit(model.remove(id));
    },
    onPark: () => {
      model
        ?.park()
        .then((id) => {
          if (id === undefined) say("Nothing to park.", "info");
          else {
            say("Sale parked.", "success");
            refreshParked();
          }
        })
        .catch(reportError);
    },
    onCustomer: () => {
      say("Customers arrive in a later update.", "info");
    },
    onPay: pay,
    onScan: () => {
      say("Camera scanning is not available on this device. Use the scanner or search.", "info");
    },
    onShowCatalog: () => {
      setCatalogOpen(true);
    },
    parkedCount: parked.length,
    onShowParked: () => {
      refreshParked();
      setParkedOpen(true);
    },
  };

  return (
    <View style={s.root}>
      <View style={s.bar}>
        <SyncChip />
        {pricing?.error === undefined ? null : (
          <View role="alert">
            <Text variant="caption" tone="danger" testID="sell-price-error">
              {pricing.error}
            </Text>
          </View>
        )}
        {sell.ready ? null : (
          <Text variant="caption" tone="muted" testID="sell-waiting">
            Waiting for prices
          </Text>
        )}
        <View style={s.barActions}>
          <Button
            label="Till"
            variant="ghost"
            onPress={() => {
              setOpsOpen(true);
            }}
            testID="till"
          />
          <Button
            label="Lock"
            variant="ghost"
            onPress={() => {
              controller.lock().catch(reportError);
            }}
            testID="lock"
          />
          <Button
            label="Sign out"
            variant="ghost"
            onPress={() => {
              controller.signOut().catch((e: unknown) => {
                reportError(e);
                say(
                  "Sales are still waiting to sync. Connect to the network and try again.",
                  "danger",
                );
              });
            }}
            testID="sign-out"
          />
        </View>
      </View>
      <SellView {...view} />

      <Sheet
        visible={catalogOpen}
        title="Products"
        onClose={() => {
          setCatalogOpen(false);
        }}
      >
        <ScrollView style={s.sheetBody}>
          <Catalog {...view} />
        </ScrollView>
      </Sheet>

      <Sheet
        visible={parkedOpen}
        title="Parked sales"
        onClose={() => {
          setParkedOpen(false);
        }}
        testID="parked-sheet"
      >
        <ScrollView style={s.sheetBody}>
          {parked.length === 0 ? <Text tone="muted">No parked sales.</Text> : null}
          {parked.map((p) => (
            <ListRow
              key={p.id}
              title={`${String(p.itemCount)} items`}
              subtitle={ageLabel(parkedAt - p.updatedAt)}
              onPress={() => {
                model
                  ?.resume(p.id)
                  .then((ok) => {
                    if (!ok) say("That sale expired and was removed.", "danger");
                    setParkedOpen(false);
                    refreshParked();
                  })
                  .catch(reportError);
              }}
            />
          ))}
        </ScrollView>
      </Sheet>

      {tender === undefined ? null : (
        <TenderSheet
          visible
          state={tender.state}
          payableMinor={tender.payable}
          currency={sell.currency ?? "USD"}
          locale={locale}
          cardAvailable={devices.adapter !== undefined}
          onCash={(m) => {
            tender.session.addCash(m).catch(reportError);
          }}
          onCard={() => {
            tender.session.takeCard().catch(reportError);
          }}
          onCancelCard={() => {
            tender.session.cancelCard();
          }}
          onRemove={(id) => {
            tender.session.removeTender(id);
          }}
          onRetrySave={() => {
            tender.session.retrySave().catch(reportError);
          }}
          onClearCardBlock={() => {
            tender.session.clearCardBlock();
          }}
          onReprint={() => {
            tender.session.reprint().catch(reportError);
          }}
          onClose={() => {
            setTender(undefined);
          }}
          onNewSale={() => {
            const done = tender.state.phase === "done";
            setTender(undefined);
            if (done) model?.finish().catch(reportError);
          }}
        />
      )}

      <OperationsSheet
        visible={opsOpen}
        onClose={() => {
          setOpsOpen(false);
        }}
        port={port}
        currency={sell.currency ?? "USD"}
        locale={locale}
      />

      <OverrideSheet
        visible={override !== undefined}
        title={override?.kind === "remove" ? "Remove item" : "Reduce quantity"}
        request={
          override === undefined
            ? undefined
            : {
                permission: "sales:edit_line",
                requesterId: operatorId,
                subjectId: override.lineId,
                reason: "",
              }
        }
        port={port}
        newId={uuidv7}
        now={Date.now}
        onApproved={(approval) => {
          if (override !== undefined) model?.applyApproved(override, approval);
          setOverride(undefined);
        }}
        onCancel={() => {
          setOverride(undefined);
        }}
      />
    </View>
  );
}
