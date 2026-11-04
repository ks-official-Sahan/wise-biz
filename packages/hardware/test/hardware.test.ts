import { describe, expect, it, vi } from "vitest";

import {
  DRAWER_KICK_BYTES,
  HardwareError,
  createMemoryPrinter,
  createMemoryScanner,
  createNetworkPrinter,
  drawerViaPrinter,
} from "../src/index.ts";

import type { TcpSocketLike } from "../src/index.ts";

type Handler = (err?: Error) => void;

function fakeSocket(behavior: { connect?: boolean; error?: boolean; writeError?: boolean }) {
  const handlers: Record<string, Handler> = {};
  const written: Uint8Array[] = [];
  const socket: TcpSocketLike & { destroyed: boolean } = {
    destroyed: false,
    write: (bytes, done) => {
      written.push(bytes);
      done(behavior.writeError === true ? new Error("EPIPE") : null);
    },
    end: () => {
      queueMicrotask(() => handlers.close?.());
    },
    destroy: () => {
      socket.destroyed = true;
    },
    on: (event, handler) => {
      handlers[event] = handler;
      if (event === "connect" && behavior.connect !== false && behavior.error !== true)
        queueMicrotask(() => {
          handler();
        });
      if (event === "error" && behavior.error === true)
        queueMicrotask(() => {
          handler(new Error("ECONNREFUSED"));
        });
    },
  };
  return { socket, written };
}

describe("network printer", () => {
  it("sends the bytes to host:9100 and closes the socket", async () => {
    const { socket, written } = fakeSocket({});
    const connect = vi.fn(() => socket);
    const printer = createNetworkPrinter({ connect, host: "10.0.0.5" });
    await printer.write(Uint8Array.from([1, 2, 3]));
    expect(connect).toHaveBeenCalledWith("10.0.0.5", 9100);
    expect(written).toEqual([Uint8Array.from([1, 2, 3])]);
    expect(socket.destroyed).toBe(true);
    expect(await printer.status()).toBe("ready");
  });

  it("reports an unreachable printer, a refused job, a throwing connect and a timeout", async () => {
    const offline = createNetworkPrinter({
      connect: () => fakeSocket({ error: true }).socket,
      host: "h",
    });
    await expect(offline.write(Uint8Array.of(1))).rejects.toMatchObject({ kind: "offline" });
    const refused = createNetworkPrinter({
      connect: () => fakeSocket({ writeError: true }).socket,
      host: "h",
    });
    await expect(refused.write(Uint8Array.of(1))).rejects.toMatchObject({ kind: "rejected" });
    const throws = createNetworkPrinter({
      connect: () => {
        throw new Error("no route");
      },
      host: "h",
    });
    await expect(throws.write(Uint8Array.of(1))).rejects.toBeInstanceOf(HardwareError);
    const silent = createNetworkPrinter({
      connect: () => fakeSocket({ connect: false }).socket,
      host: "h",
      timeoutMs: 20,
    });
    await expect(silent.write(Uint8Array.of(1))).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("network printer, sockets without end()", () => {
  it("finishes right after the flush and honours a custom port", async () => {
    const written: Uint8Array[] = [];
    const handlers: Record<string, () => void> = {};
    const socket: TcpSocketLike = {
      write: (bytes, done) => {
        written.push(bytes);
        done(null);
      },
      destroy: () => undefined,
      on: (event, handler) => {
        handlers[event] = handler;
        if (event === "connect")
          queueMicrotask(() => {
            handler();
          });
      },
    };
    const connect = vi.fn(() => socket);
    await createNetworkPrinter({ connect, host: "h", port: 9101 }).write(Uint8Array.of(7));
    expect(connect).toHaveBeenCalledWith("h", 9101);
    expect(written).toEqual([Uint8Array.of(7)]);
  });
});

describe("memory devices and drawer", () => {
  it("records jobs, can fail on demand and kicks the drawer through the printer", async () => {
    const printer = createMemoryPrinter();
    await drawerViaPrinter(printer).kick();
    expect(printer.jobs).toEqual([DRAWER_KICK_BYTES]);
    printer.fail = new HardwareError("offline", "off");
    expect(await printer.status()).toBe("offline");
    await expect(printer.write(Uint8Array.of(1))).rejects.toThrow("off");
  });

  it("delivers scans to subscribers until they unsubscribe", () => {
    const scanner = createMemoryScanner();
    const seen: string[] = [];
    const off = scanner.onScan((c) => seen.push(c));
    scanner.emit("a");
    off();
    scanner.emit("b");
    expect(seen).toEqual(["a"]);
  });
});
