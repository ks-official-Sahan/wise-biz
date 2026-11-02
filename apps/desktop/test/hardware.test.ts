import net from "node:net";

import { DRAWER_KICK_BYTES } from "@wise-biz/hardware";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  createHardwareService,
  parseHardwareConfig,
  parseScaleLine,
} from "../src/main/hardware.ts";

import type { SerialLike } from "../src/main/hardware.ts";
import type { HardwareConfig } from "../src/shared/channels.ts";

/** A TCP listener that records every job, like the receipt printer the e2e suite prints to. */
async function listener(): Promise<{ port: number; jobs: Buffer[]; close: () => Promise<void> }> {
  const jobs: Buffer[] = [];
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => {
      jobs.push(Buffer.concat(chunks));
      socket.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    jobs,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      }),
  };
}

const tcp = (host: string, port: number) => {
  const s = net.connect({ host, port });
  return {
    write: (b: Uint8Array, d: (e?: Error | null) => void) => {
      s.write(b, d);
    },
    destroy: () => {
      s.destroy();
    },
    end: () => {
      s.end();
    },
    on: (e: "error" | "close" | "connect", h: (err?: Error) => void) => {
      s.on(e, h);
    },
  };
};

function fakeSerial(opts: { fail?: "open" | "write"; lines?: string[] } = {}) {
  const sent: Uint8Array[] = [];
  const opened: [string, number][] = [];
  let closed = 0;
  const open = (path: string, baud: number): Promise<SerialLike> => {
    opened.push([path, baud]);
    if (opts.fail === "open") return Promise.reject(new Error("busy"));
    let onData: ((c: never) => void) | undefined;
    const port: SerialLike = {
      write: (b, d) => {
        if (opts.fail === "write") d(new Error("io"));
        else {
          sent.push(b);
          d();
        }
      },
      drain: (d) => {
        d();
      },
      close: (d) => {
        closed++;
        d();
      },
      on: (e, h) => {
        if (e === "data") onData = h;
      },
    };
    if (opts.lines !== undefined)
      setTimeout(() => {
        for (const l of opts.lines ?? []) onData?.(Buffer.from(`${l}\r\n`) as never);
      }, 5);
    return Promise.resolve(port);
  };
  return { open, sent, opened, closed: () => closed };
}

const service = (o: {
  config?: HardwareConfig;
  serial?: ReturnType<typeof fakeSerial>;
  saved?: HardwareConfig[];
}) =>
  createHardwareService({
    loadConfig: () => o.config,
    saveConfig: (c) => void o.saved?.push(c),
    dev: true,
    connect: tcp,
    openSerial: (p, b) => (o.serial ?? fakeSerial()).open(p, b),
    listSerial: () => Promise.resolve([{ path: "COM3" }]),
  });

describe("config validation", () => {
  it("accepts the supported shapes", () => {
    expect(
      parseHardwareConfig({
        printer: { kind: "network", host: "192.168.1.50", port: 9100 },
        scale: { kind: "serial", path: "COM4", baudRate: 9600 },
      }),
    ).toEqual({
      printer: { kind: "network", host: "192.168.1.50", port: 9100 },
      scale: { kind: "serial", path: "COM4", baudRate: 9600 },
    });
    expect(
      parseHardwareConfig({
        printer: { kind: "serial", path: "/dev/ttyUSB0", baudRate: 115200 },
        scale: { kind: "none" },
      }).printer.kind,
    ).toBe("serial");
    expect(parseHardwareConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });

  it("refuses everything else", () => {
    const base = { scale: { kind: "none" } };
    const bad: unknown[] = [
      null,
      [],
      { printer: { kind: "none" } },
      { ...base, printer: { kind: "usb" } },
      { ...base, printer: { kind: "network", host: "http://x", port: 9100 } },
      { ...base, printer: { kind: "network", host: "a b", port: 9100 } },
      { ...base, printer: { kind: "network", host: "x".repeat(300), port: 9100 } },
      { ...base, printer: { kind: "network", host: "10.0.0.1", port: 0 } },
      { ...base, printer: { kind: "network", host: "10.0.0.1", port: 70000 } },
      { ...base, printer: { kind: "network", host: "10.0.0.1", port: 9100.5 } },
      { ...base, printer: { kind: "serial", path: "C:\\evil", baudRate: 9600 } },
      { ...base, printer: { kind: "serial", path: "/dev/../etc/passwd", baudRate: 9600 } },
      { ...base, printer: { kind: "serial", path: "COM1", baudRate: 1 } },
      { printer: { kind: "none" }, scale: { kind: "network" } },
    ];
    for (const b of bad) expect(() => parseHardwareConfig(b), JSON.stringify(b)).toThrow();
  });
});

describe("printing", () => {
  it("sends a receipt to a network printer and the drawer pulse after it", async () => {
    const l = await listener();
    const hw = service({});
    hw.setConfig({
      printer: { kind: "network", host: "127.0.0.1", port: l.port },
      scale: { kind: "none" },
    });
    const receipt = Uint8Array.from([0x1b, 0x40, 0x41, 0x0a]);
    await hw.print(receipt);
    await hw.kick();
    expect(l.jobs.map((j) => [...j])).toEqual([[...receipt], [...DRAWER_KICK_BYTES]]);
    await l.close();
  });

  it("writes to a serial printer and always closes the port", async () => {
    const serial = fakeSerial();
    const hw = service({
      config: {
        printer: { kind: "serial", path: "COM3", baudRate: 9600 },
        scale: { kind: "none" },
      },
      serial,
    });
    await hw.print(Uint8Array.from([1, 2, 3]));
    expect(serial.opened).toEqual([["COM3", 9600]]);
    expect([...(serial.sent[0] ?? [])]).toEqual([1, 2, 3]);
    expect(serial.closed()).toBe(1);

    const broken = fakeSerial({ fail: "write" });
    const hw2 = service({
      config: {
        printer: { kind: "serial", path: "COM3", baudRate: 9600 },
        scale: { kind: "none" },
      },
      serial: broken,
    });
    await expect(hw2.print(Uint8Array.of(1))).rejects.toThrow("refused");
    expect(broken.closed()).toBe(1);
    const busy = service({
      config: {
        printer: { kind: "serial", path: "COM3", baudRate: 9600 },
        scale: { kind: "none" },
      },
      serial: fakeSerial({ fail: "open" }),
    });
    await expect(busy.print(Uint8Array.of(1))).rejects.toThrow("cannot open");
  });

  it("reports an unreachable printer and refuses bad jobs", async () => {
    const hw = service({});
    await expect(hw.print(Uint8Array.of(1))).rejects.toThrow("No printer");
    hw.setConfig({
      printer: { kind: "network", host: "127.0.0.1", port: 1 },
      scale: { kind: "none" },
    });
    await expect(hw.print(Uint8Array.of(1))).rejects.toThrow("cannot reach");
    await expect(hw.print(new Uint8Array(0))).rejects.toThrow("Invalid print job");
    await expect(hw.print(new Uint8Array(600 * 1024))).rejects.toThrow("Invalid print job");
    await expect(hw.print("text")).rejects.toThrow("Invalid print job");
  });

  it("persists a new configuration and lists ports", async () => {
    const saved: HardwareConfig[] = [];
    const hw = service({ saved });
    expect(hw.config()).toEqual(DEFAULT_CONFIG);
    hw.setConfig({
      printer: { kind: "none" },
      scale: { kind: "serial", path: "COM5", baudRate: 9600 },
    });
    expect(saved).toHaveLength(1);
    expect(await hw.ports()).toEqual([{ path: "COM3" }]);
    expect(() => hw.setConfig({ printer: { kind: "bogus" } })).toThrow();
    expect(saved).toHaveLength(1);
  });
});

describe("scale", () => {
  it("parses common line formats", () => {
    expect(parseScaleLine("ST,GS,  1.250kg")).toEqual({ grams: 1250, stable: true });
    expect(parseScaleLine("US,GS,  0.002 kg")).toEqual({ grams: 2, stable: false });
    expect(parseScaleLine("  0.480 kg")).toEqual({ grams: 480, stable: true });
    expect(parseScaleLine("N 125 g")).toEqual({ grams: 125, stable: true });
    expect(parseScaleLine("+0.000kg")).toEqual({ grams: 0, stable: true });
    expect(parseScaleLine("hello")).toBeUndefined();
    expect(parseScaleLine("")).toBeUndefined();
  });

  it("returns the first stable reading, or the last unstable one at the timeout", async () => {
    const cfg: HardwareConfig = {
      printer: { kind: "none" },
      scale: { kind: "serial", path: "COM4", baudRate: 9600 },
    };
    const stable = service({
      config: cfg,
      serial: fakeSerial({ lines: ["US,GS, 0.100 kg", "ST,GS, 0.250 kg", "ST,GS, 9.999 kg"] }),
    });
    expect(await stable.scale()).toEqual({ grams: 250, stable: true });
    const moving = service({ config: cfg, serial: fakeSerial({ lines: ["US,GS, 0.100 kg"] }) });
    expect(await moving.scale()).toEqual({ grams: 100, stable: false });
    const silent = service({ config: cfg, serial: fakeSerial({ lines: [] }) });
    expect(await silent.scale()).toBeUndefined();
    await expect(service({}).scale()).rejects.toThrow("No scale");
    await expect(
      service({ config: cfg, serial: fakeSerial({ fail: "open" }) }).scale(),
    ).rejects.toThrow("cannot open");
  });
});

describe("production rules", () => {
  const prod = (printer: unknown) => () =>
    parseHardwareConfig({ printer, scale: { kind: "none" } }, { dev: false });

  it("accepts only printer ports and refuses loopback and link-local hosts", () => {
    expect(prod({ kind: "network", host: "192.168.1.50", port: 9100 })).not.toThrow();
    expect(prod({ kind: "network", host: "printer.lan", port: 9103 })).not.toThrow();
    expect(prod({ kind: "network", host: "192.168.1.50", port: 6379 })).toThrow("printer port");
    expect(prod({ kind: "network", host: "127.0.0.1", port: 9100 })).toThrow("printer address");
    expect(prod({ kind: "network", host: "localhost", port: 9100 })).toThrow("printer address");
    expect(prod({ kind: "network", host: "169.254.169.254", port: 9100 })).toThrow(
      "printer address",
    );
    expect(prod({ kind: "network", host: "0.0.0.0", port: 9100 })).toThrow("printer address");
    // Developer machines may use loopback and any port.
    expect(() =>
      parseHardwareConfig(
        { printer: { kind: "network", host: "127.0.0.1", port: 40123 }, scale: { kind: "none" } },
        { dev: true },
      ),
    ).not.toThrow();
  });

  it("accepts serial devices by name only", () => {
    for (const path of [
      "COM3",
      "/dev/ttyUSB0",
      "/dev/ttyACM1",
      "/dev/ttyS0",
      "/dev/cu.usbserial-1410",
    ])
      expect(prod({ kind: "serial", path, baudRate: 9600 }), path).not.toThrow();
    for (const path of ["/dev/sda", "/dev/mem", "/dev/null", "/dev/tty", "/dev/ttyUSB0/../sda"])
      expect(prod({ kind: "serial", path, baudRate: 9600 }), path).toThrow("serial port");
  });
});

describe("limits", () => {
  it("ignores overlong scale lines", () => {
    expect(parseScaleLine("ST,GS," + " ".repeat(5000) + "1.0kg")).toBeUndefined();
  });

  it("does not let a hung serial device block the queue forever, and bounds the queue", async () => {
    const hang = createHardwareService({
      loadConfig: () => ({
        printer: { kind: "serial", path: "COM3", baudRate: 9600 },
        scale: { kind: "none" },
      }),
      saveConfig: () => undefined,
      connect: tcp,
      openSerial: () => {
        return new Promise(() => undefined);
      },
      listSerial: () => Promise.resolve([]),
    });
    const jobs = Array.from({ length: 25 }, () =>
      hang.print(Uint8Array.of(1)).catch((e: unknown) => (e instanceof Error ? e.message : "")),
    );
    const results = await Promise.all(jobs.slice(20));
    expect(results.every((m) => m === "The printer is busy.")).toBe(true);
  }, 5000);
});
