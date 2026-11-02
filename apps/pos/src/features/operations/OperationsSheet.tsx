import { uuidv7 } from "@wise-biz/ids";
import {
  Badge,
  Button,
  Chip,
  ListRow,
  Sheet,
  Tabs,
  Text,
  TextField,
  createStyles,
  useToast,
} from "@wise-biz/ui";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useStore } from "react-redux";

import { reportError } from "../../runtime/report.ts";
import { useController } from "../../ui/context.tsx";
import { OverrideSheet } from "../overrides/OverrideSheet.tsx";
import {
  RETURN_PERMISSION,
  commitReturn,
  recentSales,
  returnableLines,
} from "../returns/model/returns.ts";
import { fromQty4, toQty4 } from "../sell/model/qty.ts";
import { permissionsOf } from "../sell/model/rules.ts";
import { formatMinor } from "../sell/model/view.ts";
import {
  closeShift,
  currentShift,
  openShift,
  recordCashMovement,
  zReport,
} from "../shift/model/shift.ts";
import { parseMajor } from "../tender/model/tender.ts";
import {
  VOID_PERMISSION,
  VOID_WINDOW_MS,
  voidNeedsOverride,
  voidSale,
} from "../void/model/void.ts";

import type { Approval } from "../../state/slices.ts";
import type { PosStore } from "../../state/store.ts";
import type { OverridePort } from "../overrides/port.ts";
import type { ReturnableLine, StoredSale } from "../returns/model/returns.ts";
import type { CashMovementKind, CloseResult, ShiftRow, ZReport } from "../shift/model/shift.ts";

const useStyles = createStyles((t) => ({
  body: { padding: t.space[4], gap: t.space[3], maxHeight: 640 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: t.space[2] },
  stat: { flexDirection: "row", justifyContent: "space-between" },
}));

const KINDS: readonly { key: CashMovementKind; label: string }[] = [
  { key: "pay_in", label: "Pay in" },
  { key: "pay_out", label: "Pay out" },
  { key: "float_add", label: "Add float" },
  { key: "drop", label: "Drop to safe" },
];

export interface OperationsSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly port: OverridePort;
  readonly currency: string;
  readonly locale: string;
}

type Pending =
  | { readonly kind: "return"; readonly permission: string; readonly subjectId: string }
  | { readonly kind: "void"; readonly permission: string; readonly subjectId: string };

/**
 * Shift and after-sale operations in one sheet: open/close the till with a blind count and a Z-report, cash in and out,
 * and returns and voids of recent sales. Everything works on the local database, so it works offline; what needs a
 * supervisor goes through the override sheet.
 */
export function OperationsSheet(p: OperationsSheetProps) {
  const s = useStyles();
  const toast = useToast();
  const controller = useController();
  const store = useStore() as unknown as PosStore;
  const [tab, setTab] = useState("shift");

  const deps = controller.sellDeps();
  const operatorId = store.getState().session.operator?.userId ?? "";
  const perms = () => permissionsOf(store.getState().session.operator?.permissions);
  const fmt = (n: number) => formatMinor(n, p.currency, p.locale);
  const say = useCallback(
    (message: string, tone: "info" | "danger" | "success" = "info") => {
      toast.show({ message, tone });
    },
    [toast],
  );
  const fail = (e: unknown) => {
    if (e instanceof Error && e.name.endsWith("Error") && e.name !== "Error")
      say(e.message, "danger");
    else {
      reportError(e);
      say("Something went wrong. Nothing was changed.", "danger");
    }
  };
  const base = () =>
    deps === undefined
      ? undefined
      : { transaction: deps.transaction, now: Date.now, newId: uuidv7, operatorId };

  // ---- shift ----
  const [shift, setShift] = useState<ShiftRow>();
  const [report, setReport] = useState<ZReport>();
  const [closed, setClosed] = useState<CloseResult>();
  const [float, setFloat] = useState("");
  const [kind, setKind] = useState<CashMovementKind>("pay_in");
  const [amount, setAmount] = useState("");
  const [why, setWhy] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");

  const loadShift = useCallback(async () => {
    if (deps === undefined) return;
    const cur = await currentShift(deps.db);
    setShift(cur);
    setReport(cur === undefined ? undefined : await zReport(deps.db, cur.id));
  }, [deps]);

  // ---- sales ----
  const [openedAt, setOpenedAt] = useState(0);
  const [numberText, setNumberText] = useState("");
  const [sales, setSales] = useState<StoredSale[]>([]);
  const [picked, setPicked] = useState<StoredSale>();
  const [left, setLeft] = useState<ReturnableLine[]>([]);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [disposition, setDisposition] = useState<"restock" | "writeoff">("restock");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<Pending>();

  const loadSales = useCallback(
    async (text: string) => {
      if (deps === undefined) return;
      const n = text.trim() === "" ? undefined : Number(text);
      setSales(
        await recentSales(deps.db, {
          now: Date.now(),
          ...(n === undefined || !Number.isInteger(n) ? {} : { saleNo: n }),
        }),
      );
    },
    [deps],
  );

  const pick = useCallback(
    async (sale: StoredSale | undefined) => {
      setPicked(sale);
      setOpenedAt(Date.now());
      setQty({});
      setReason("");
      setLeft(sale === undefined || deps === undefined ? [] : await returnableLines(deps.db, sale));
    },
    [deps],
  );

  useEffect(() => {
    if (!p.visible) return;
    // Opening the sheet resets it and reloads from the local database.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClosed(undefined);
    loadShift().catch(reportError);
    loadSales("").catch(reportError);
    pick(undefined).catch(reportError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.visible]);

  const refreshAll = async () => {
    await loadShift();
    await loadSales(numberText);
    if (picked !== undefined && deps !== undefined) {
      const fresh = (await recentSales(deps.db, { now: Date.now(), saleNo: picked.saleNo })).find(
        (x) => x.id === picked.id,
      );
      await pick(fresh);
    }
  };

  const doReturn = (approval?: Approval) => {
    const b = base();
    if (b === undefined || picked === undefined || deps === undefined) return;
    const lines = left.flatMap((l) => {
      const q = qty[l.saleLine];
      return q === undefined || (toQty4(q) ?? 0) <= 0
        ? []
        : [{ saleLine: l.saleLine, qty: q, disposition }];
    });
    commitReturn(
      {
        ...b,
        locationOf: (v) => picked.lines.find((l) => l.variantId === v)?.locationId ?? "",
        has: (x) => perms().has(x),
      },
      { sale: picked, lines, reason, ...(approval === undefined ? {} : { approval }) },
    )
      .then(async (r) => {
        say(`Return ${String(r.returnNo)} saved. Refund ${fmt(r.cashMinor)} in cash.`, "success");
        await refreshAll();
      })
      .catch((e: unknown) => {
        if (e instanceof Error && "code" in e && e.code === "needs_override")
          setPending({ kind: "return", permission: RETURN_PERMISSION, subjectId: picked.id });
        else fail(e);
      });
  };

  const doVoid = (approval?: Approval) => {
    const b = base();
    if (b === undefined || picked === undefined) return;
    voidSale(
      { ...b, has: (x) => perms().has(x) },
      { saleId: picked.id, reason, ...(approval === undefined ? {} : { approval }) },
    )
      .then(async () => {
        say("Sale voided.", "success");
        await refreshAll();
      })
      .catch((e: unknown) => {
        if (e instanceof Error && "code" in e && e.code === "needs_override")
          setPending({ kind: "void", permission: VOID_PERMISSION, subjectId: picked.id });
        else fail(e);
      });
  };

  const step = (l: ReturnableLine, dir: 1 | -1) => {
    const max = toQty4(l.qtyLeft) ?? 0;
    const cur = toQty4(qty[l.saleLine] ?? "0") ?? 0;
    const unit = max % 10_000 === 0 ? 10_000 : max;
    const next = Math.min(max, Math.max(0, cur + dir * unit));
    setQty((q) => ({ ...q, [l.saleLine]: fromQty4(next) }));
  };

  const refundPreview = left.reduce((n, l) => {
    const q = toQty4(qty[l.saleLine] ?? "0") ?? 0;
    const max = toQty4(l.qtyLeft) ?? 1;
    return n + (q <= 0 ? 0 : Math.round((l.line.totalMinor * q) / (toQty4(l.line.qty) ?? max)));
  }, 0);

  const needsVoidApproval =
    picked !== undefined && voidNeedsOverride(picked.completedAt, openedAt, (x) => perms().has(x));

  return (
    <>
      <Sheet visible={p.visible} title="Till and sales" onClose={p.onClose} testID="ops-sheet">
        <View style={{ paddingHorizontal: 16 }}>
          <Tabs
            items={[
              { key: "shift", label: "Shift" },
              { key: "sales", label: "Sales" },
            ]}
            value={tab}
            onChange={setTab}
            accessibilityLabel="Till and sales"
            testID="ops-tabs"
          />
        </View>
        <ScrollView contentContainerStyle={s.body}>
          {deps === undefined ? (
            <Text tone="muted">The terminal is still starting.</Text>
          ) : tab === "shift" ? (
            closed !== undefined ? (
              <View style={{ gap: 8 }}>
                <Text variant="heading">Shift closed</Text>
                <View testID="ops-variance">
                  <Badge
                    tone={closed.varianceMinor === 0 ? "success" : "danger"}
                    label={
                      closed.varianceMinor === 0
                        ? "Drawer matches"
                        : closed.varianceMinor > 0
                          ? `Over by ${fmt(closed.varianceMinor)}`
                          : `Short by ${fmt(-closed.varianceMinor)}`
                    }
                  />
                </View>
                <ReportRows report={closed.report} fmt={fmt} s={s} />
                <View style={s.stat}>
                  <Text>Counted</Text>
                  <Text numeric>{fmt(closed.countedMinor)}</Text>
                </View>
              </View>
            ) : shift === undefined ? (
              <View style={{ gap: 8 }}>
                <Text variant="heading">No open shift</Text>
                <Text tone="muted">Count the cash in the drawer and enter it as the float.</Text>
                <TextField
                  label="Opening float"
                  value={float}
                  onChangeText={setFloat}
                  keyboardType="decimal-pad"
                  testID="ops-float"
                />
                <Button
                  label="Open shift"
                  testID="ops-open"
                  onPress={() => {
                    const minor = float.trim() === "" ? 0 : parseMajor(float, p.currency);
                    const b = base();
                    if (minor === undefined || b === undefined) {
                      say("Enter the float as a number, like 100.00.", "danger");
                      return;
                    }
                    openShift(b, { floatMinor: minor, currency: p.currency })
                      .then(async () => {
                        setFloat("");
                        await loadShift();
                      })
                      .catch(fail);
                  }}
                />
              </View>
            ) : (
              <View style={{ gap: 12 }}>
                <Text variant="heading">Shift open</Text>
                {report === undefined ? null : (
                  <ReportRows report={report} fmt={fmt} s={s} hideExpected />
                )}
                <Text variant="label" tone="muted">
                  Cash in and out
                </Text>
                <View style={s.row}>
                  {KINDS.map((k) => (
                    <Chip
                      key={k.key}
                      label={k.label}
                      selected={kind === k.key}
                      onPress={() => {
                        setKind(k.key);
                      }}
                      testID={`ops-kind-${k.key}`}
                    />
                  ))}
                </View>
                <TextField
                  label="Amount"
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  testID="ops-amount"
                />
                <TextField label="Reason" value={why} onChangeText={setWhy} testID="ops-why" />
                <Button
                  label="Record"
                  variant="secondary"
                  testID="ops-record"
                  onPress={() => {
                    const minor = parseMajor(amount, p.currency);
                    const b = base();
                    if (minor === undefined || b === undefined) {
                      say("Enter the amount as a number, like 20.00.", "danger");
                      return;
                    }
                    recordCashMovement(b, { kind, amountMinor: minor, reason: why })
                      .then(async () => {
                        setAmount("");
                        setWhy("");
                        say("Recorded.", "success");
                        await loadShift();
                      })
                      .catch(fail);
                  }}
                />
                <Text variant="label" tone="muted">
                  Close the shift
                </Text>
                <TextField
                  label="Counted cash in the drawer"
                  value={counted}
                  onChangeText={setCounted}
                  keyboardType="decimal-pad"
                  helper="Count first. The expected amount shows after you close."
                  testID="ops-counted"
                />
                <TextField label="Note (optional)" value={note} onChangeText={setNote} />
                <Button
                  label="Close shift"
                  testID="ops-close"
                  onPress={() => {
                    const minor = parseMajor(counted, p.currency);
                    const b = base();
                    if (minor === undefined || b === undefined) {
                      say("Enter the counted cash as a number, like 250.00.", "danger");
                      return;
                    }
                    closeShift(b, { countedMinor: minor, blind: true, note })
                      .then(async (r) => {
                        setClosed(r);
                        setCounted("");
                        setNote("");
                        await loadShift();
                      })
                      .catch(fail);
                  }}
                />
              </View>
            )
          ) : picked === undefined ? (
            <View style={{ gap: 8 }}>
              <TextField
                label="Find by sale number"
                value={numberText}
                onChangeText={(t) => {
                  setNumberText(t);
                  loadSales(t).catch(reportError);
                }}
                keyboardType="number-pad"
                testID="ops-find"
              />
              {sales.length === 0 ? (
                <Text tone="muted">No sales found on this terminal.</Text>
              ) : null}
              {sales.map((x) => (
                <ListRow
                  key={x.id}
                  title={`Sale ${String(x.saleNo)}${x.voidedAt === undefined ? "" : " (voided)"}`}
                  subtitle={new Date(x.completedAt).toLocaleString(p.locale)}
                  trailing={<Text numeric>{fmt(x.payableMinor)}</Text>}
                  onPress={() => {
                    pick(x).catch(reportError);
                  }}
                  testID={`ops-sale-${String(x.saleNo)}`}
                />
              ))}
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              <Button
                label="Back to sales"
                variant="ghost"
                onPress={() => {
                  pick(undefined).catch(reportError);
                }}
              />
              <Text variant="heading">{`Sale ${String(picked.saleNo)} · ${fmt(picked.payableMinor)}`}</Text>
              {picked.voidedAt === undefined ? null : <Badge tone="danger" label="Voided" />}
              {left.length === 0 && picked.voidedAt === undefined ? (
                <Text tone="muted">Everything on this sale was returned.</Text>
              ) : null}
              {left.map((l) => (
                <ListRow
                  key={l.saleLine}
                  title={l.line.name}
                  subtitle={`${l.qtyLeft} left to return`}
                  trailing={
                    <View style={s.row}>
                      <Button
                        label="−"
                        variant="secondary"
                        onPress={() => {
                          step(l, -1);
                        }}
                        testID={`ops-minus-${String(l.saleLine)}`}
                      />
                      <Text numeric testID={`ops-qty-${String(l.saleLine)}`}>
                        {qty[l.saleLine] ?? "0"}
                      </Text>
                      <Button
                        label="+"
                        variant="secondary"
                        onPress={() => {
                          step(l, 1);
                        }}
                        testID={`ops-plus-${String(l.saleLine)}`}
                      />
                    </View>
                  }
                />
              ))}
              {picked.voidedAt !== undefined ? null : (
                <>
                  <TextField
                    label="Reason"
                    value={reason}
                    onChangeText={setReason}
                    testID="ops-reason"
                  />
                  <View style={s.row}>
                    <Chip
                      label="Put back in stock"
                      selected={disposition === "restock"}
                      onPress={() => {
                        setDisposition("restock");
                      }}
                    />
                    <Chip
                      label="Write off"
                      selected={disposition === "writeoff"}
                      onPress={() => {
                        setDisposition("writeoff");
                      }}
                    />
                  </View>
                  <Button
                    label={
                      refundPreview > 0 ? `Return and refund ${fmt(refundPreview)} cash` : "Return"
                    }
                    disabled={refundPreview <= 0}
                    onPress={() => {
                      doReturn();
                    }}
                    testID="ops-return"
                  />
                  <Button
                    label={needsVoidApproval ? "Void sale (supervisor)" : "Void whole sale"}
                    variant="secondary"
                    onPress={() => {
                      doVoid();
                    }}
                    testID="ops-void"
                  />
                  <Text variant="caption" tone="muted">
                    {`A sale can be voided by you for ${String(VOID_WINDOW_MS / 60_000)} minutes. Part-returned sales cannot be voided.`}
                  </Text>
                </>
              )}
            </View>
          )}
        </ScrollView>
      </Sheet>
      <OverrideSheet
        visible={pending !== undefined}
        title={pending?.kind === "void" ? "Approve void" : "Approve return"}
        request={
          pending === undefined
            ? undefined
            : {
                permission: pending.permission,
                requesterId: operatorId,
                subjectId: pending.subjectId,
                reason: "",
              }
        }
        port={p.port}
        newId={uuidv7}
        now={Date.now}
        onApproved={(approval) => {
          const kindNow = pending?.kind;
          setPending(undefined);
          if (kindNow === "void") doVoid(approval);
          else doReturn(approval);
        }}
        onCancel={() => {
          setPending(undefined);
        }}
      />
    </>
  );
}

function ReportRows({
  report,
  fmt,
  s,
  hideExpected = false,
}: {
  report: ZReport;
  fmt: (n: number) => string;
  s: { stat: object };
  hideExpected?: boolean;
}) {
  const rows: [string, string][] = [
    [`Sales (${String(report.salesCount)})`, fmt(report.salesMinor)],
    [`Returns (${String(report.returnsCount)})`, fmt(report.returnsMinor)],
    [`Voided sales`, String(report.voidedCount)],
    ...Object.entries(report.byTender).map(([k, v]): [string, string] => [`Net ${k}`, fmt(v)]),
    ["Pay in", fmt(report.payInMinor)],
    ["Pay out", fmt(report.payOutMinor)],
    ["Drops", fmt(report.dropsMinor)],
    ...(hideExpected
      ? []
      : ([["Expected cash", fmt(report.expectedCashMinor)]] as [string, string][])),
  ];
  return (
    <View testID="ops-report">
      {rows.map(([k, v]) => (
        <View key={k} style={s.stat}>
          <Text tone="muted">{k}</Text>
          <Text numeric>{v}</Text>
        </View>
      ))}
    </View>
  );
}
