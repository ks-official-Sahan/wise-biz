import { Badge, Button, Chip, Sheet, Text, TextField, createStyles, useToast } from "@wise-biz/ui";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import { reportError } from "../../runtime/report.ts";

import type { DesktopBridge, HardwareConfig, ScreenInfo } from "../../runtime/desktop.ts";

const useStyles = createStyles((t) => ({
  body: { padding: t.space[4], gap: t.space[3], maxHeight: 640 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: t.space[2] },
}));

const BAUDS = [9600, 19200, 38400, 115200];

// ESC @ (initialise), a short line, three feeds and a partial cut.
const TEST_PAGE = Uint8Array.from([
  0x1b,
  0x40,
  ...Array.from("Wise Biz test print\n").map((c) => c.charCodeAt(0)),
  0x0a,
  0x0a,
  0x0a,
  0x1d,
  0x56,
  0x01,
]);

/**
 * Desktop-only device settings: the receipt printer (network or serial), the customer display screen and kiosk mode.
 * When an admin PIN exists the sheet asks for it first, so a cashier cannot repoint the printer or leave kiosk mode.
 */
export function DevicesSheet(p: { visible: boolean; onClose: () => void; bridge: DesktopBridge }) {
  const s = useStyles();
  const toast = useToast();
  const { bridge } = p;
  const say = useCallback(
    (message: string, tone: "info" | "danger" | "success" = "info") => {
      toast.show({ message, tone });
    },
    [toast],
  );
  const fail = (e: unknown) => {
    reportError(e);
    say(e instanceof Error ? e.message : "That did not work.", "danger");
  };

  const [locked, setLocked] = useState<boolean | undefined>();
  const [pin, setPin] = useState("");
  const [config, setConfig] = useState<HardwareConfig>();
  const [ports, setPorts] = useState<string[]>([]);
  const [host, setHost] = useState("");
  const [port, setPortText] = useState("9100");
  const [screens, setScreens] = useState<ScreenInfo[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [kiosk, setKiosk] = useState<{ enabled: boolean; hasPin: boolean }>();
  const [newPin, setNewPin] = useState("");

  const load = useCallback(async () => {
    const [c, pl, sc, k] = await Promise.all([
      bridge.hw.config(),
      bridge.hw.ports().catch(() => []),
      bridge.display.screens(),
      bridge.kiosk.status(),
    ]);
    setConfig(c);
    setPorts(pl.map((x) => x.path));
    if (c.printer.kind === "network") {
      setHost(c.printer.host);
      setPortText(String(c.printer.port));
    }
    setScreens(sc.screens);
    setChosen(sc.chosen);
    setKiosk(k);
    setLocked(k.hasPin);
  }, [bridge]);

  useEffect(() => {
    if (!p.visible) return;
    // Opening the sheet resets it and reloads the saved settings from the shell.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPin("");
    load().catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.visible]);

  const save = (next: HardwareConfig) => {
    bridge.hw
      .setConfig(next)
      .then((c) => {
        setConfig(c);
        say("Saved.", "success");
      })
      .catch(fail);
  };

  const printer = config?.printer;
  const serialPath = printer?.kind === "serial" ? printer.path : undefined;
  const baud = printer?.kind === "serial" ? printer.baudRate : 9600;

  return (
    <Sheet visible={p.visible} title="Devices" onClose={p.onClose} testID="devices-sheet">
      <ScrollView contentContainerStyle={s.body}>
        {locked === true ? (
          <View style={{ gap: 8 }}>
            <Text tone="muted">Enter the admin PIN to change devices.</Text>
            <TextField
              label="Admin PIN"
              value={pin}
              onChangeText={setPin}
              secureTextEntry
              keyboardType="number-pad"
              testID="devices-pin"
            />
            <Button
              label="Unlock"
              testID="devices-unlock"
              onPress={() => {
                bridge.kiosk
                  .verify(pin)
                  .then(() => {
                    setLocked(false);
                  })
                  .catch(fail);
              }}
            />
          </View>
        ) : (
          <>
            <Text variant="heading">Receipt printer</Text>
            <View style={s.row}>
              {(["none", "network", "serial"] as const).map((k) => (
                <Chip
                  key={k}
                  label={k === "none" ? "None" : k === "network" ? "Network" : "Serial / USB-COM"}
                  selected={printer?.kind === k}
                  onPress={() => {
                    if (config === undefined) return;
                    if (k === "none") save({ ...config, printer: { kind: "none" } });
                    else if (k === "network")
                      setConfig({
                        ...config,
                        printer: { kind: "network", host, port: Number(port) || 9100 },
                      });
                    else
                      setConfig({
                        ...config,
                        printer: { kind: "serial", path: ports[0] ?? "COM1", baudRate: 9600 },
                      });
                  }}
                  testID={`devices-printer-${k}`}
                />
              ))}
            </View>
            {printer?.kind === "network" ? (
              <View style={{ gap: 8 }}>
                <TextField
                  label="Printer address"
                  value={host}
                  onChangeText={setHost}
                  testID="devices-host"
                />
                <TextField
                  label="Port"
                  value={port}
                  onChangeText={setPortText}
                  keyboardType="number-pad"
                  testID="devices-port"
                />
                <Button
                  label="Save printer"
                  testID="devices-save-printer"
                  onPress={() => {
                    if (config === undefined) return;
                    save({
                      ...config,
                      printer: { kind: "network", host: host.trim(), port: Number(port) },
                    });
                  }}
                />
              </View>
            ) : null}
            {printer?.kind === "serial" ? (
              <View style={{ gap: 8 }}>
                <Text variant="label" tone="muted">
                  Port
                </Text>
                <View style={s.row}>
                  {(ports.length === 0 ? ["COM1"] : ports).map((x) => (
                    <Chip
                      key={x}
                      label={x}
                      selected={serialPath === x}
                      onPress={() => {
                        if (config !== undefined)
                          setConfig({
                            ...config,
                            printer: { kind: "serial", path: x, baudRate: baud },
                          });
                      }}
                    />
                  ))}
                </View>
                <View style={s.row}>
                  {BAUDS.map((b) => (
                    <Chip
                      key={b}
                      label={String(b)}
                      selected={baud === b}
                      onPress={() => {
                        if (config !== undefined && serialPath !== undefined)
                          setConfig({
                            ...config,
                            printer: { kind: "serial", path: serialPath, baudRate: b },
                          });
                      }}
                    />
                  ))}
                </View>
                <Button
                  label="Save printer"
                  onPress={() => {
                    if (config !== undefined) save({ ...config, printer });
                  }}
                />
              </View>
            ) : null}
            <View style={s.row}>
              <Button
                label="Test print"
                variant="secondary"
                testID="devices-test-print"
                onPress={() => {
                  bridge.hw.print(TEST_PAGE).then(() => {
                    say("Test page sent.", "success");
                  }, fail);
                }}
              />
              <Button
                label="Open drawer"
                variant="secondary"
                testID="devices-kick"
                onPress={() => {
                  bridge.hw.kick().then(() => {
                    say("Drawer opened.", "success");
                  }, fail);
                }}
              />
            </View>

            <Text variant="heading">Customer display</Text>
            <View style={s.row}>
              <Chip
                label="Off"
                selected={chosen === null}
                onPress={() => {
                  bridge.display.choose(null).then(() => {
                    setChosen(null);
                  }, fail);
                }}
              />
              {screens
                .filter((x) => !x.primary)
                .map((x) => (
                  <Chip
                    key={x.id}
                    label={`${x.label} ${String(x.width)}×${String(x.height)}`}
                    selected={chosen === x.id}
                    onPress={() => {
                      bridge.display.choose(x.id).then(() => {
                        setChosen(x.id);
                      }, fail);
                    }}
                    testID={`devices-screen-${String(x.id)}`}
                  />
                ))}
            </View>
            {screens.filter((x) => !x.primary).length === 0 ? (
              <Text variant="caption" tone="muted">
                No second screen is connected.
              </Text>
            ) : null}

            <Text variant="heading">Kiosk mode</Text>
            <View style={s.row}>
              <Badge
                tone={kiosk?.enabled === true ? "success" : "info"}
                label={kiosk?.enabled === true ? "On" : "Off"}
              />
            </View>
            <TextField
              label={
                kiosk?.hasPin === true
                  ? "New admin PIN (6 to 12 digits)"
                  : "Admin PIN (6 to 12 digits)"
              }
              value={newPin}
              onChangeText={setNewPin}
              secureTextEntry
              keyboardType="number-pad"
              testID="devices-new-pin"
            />
            <View style={s.row}>
              <Button
                label="Set PIN"
                variant="secondary"
                testID="devices-set-pin"
                onPress={() => {
                  bridge.kiosk
                    .setPin(newPin, pin === "" ? undefined : pin)
                    .then(async () => {
                      setNewPin("");
                      setKiosk(await bridge.kiosk.status());
                      say("PIN saved.", "success");
                    })
                    .catch(fail);
                }}
              />
              <Button
                label={kiosk?.enabled === true ? "Leave kiosk mode" : "Start kiosk mode"}
                testID="devices-kiosk"
                onPress={() => {
                  const on = kiosk?.enabled !== true;
                  bridge.kiosk
                    .setEnabled(on, on ? undefined : pin)
                    .then(async () => {
                      setKiosk(await bridge.kiosk.status());
                    })
                    .catch(fail);
                }}
              />
            </View>
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}
