// Reads the layout from a keyboard over ZMK Studio, for keyboards whose layout
// only lives on the device, such as ones set up with Kinesis's Clique app.
//
// Studio keeps the keymap behind a lock. The user unlocks it with the
// &studio_unlock key (Mod + Esc on Kinesis's default layout), and the
// firmware locks again when the connection closes, so one connection has to
// stay open from the unlock prompt through the read.

import { SerialPort } from "serialport";
import type { RpcConnection } from "@zmkfirmware/zmk-studio-ts-client";
import type { RpcTransport } from "@zmkfirmware/zmk-studio-ts-client/transport/index";

// The client's protobuf import only resolves through a bundler, so it's
// bundled for Node by `npm run vendor`.
import { call_rpc, create_rpc_connection } from "./vendor/zmk-studio-client.js";

import { usageToCode } from "../shared/hid";
import type { Layer } from "../shared/types";

const LOCKED = 0;
const UNLOCKED = 1;

function serialTransport(path: string): Promise<{ transport: RpcTransport; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
    port.open((err) => {
      if (err) return reject(err);
      const abortController = new AbortController();
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          port.on("data", (d: Buffer) => controller.enqueue(new Uint8Array(d)));
          port.on("close", () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          });
          port.on("error", (e) => controller.error(e));
        },
      });
      const writable = new WritableStream<Uint8Array>({
        write: (chunk) =>
          new Promise((res, rej) => port.write(Buffer.from(chunk), (e) => (e ? rej(e) : port.drain(() => res())))),
      });
      // Closing the port ends the stream cleanly. Aborting instead makes the
      // client log an error.
      const close = () =>
        new Promise<void>((res) => {
          if (port.isOpen) port.close(() => res());
          else res();
        });
      resolve({ transport: { label: path, abortController, readable, writable }, close });
    });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
}

interface Session {
  conn: RpcConnection;
  close: () => Promise<void>;
  name: string;
}

/** Opens the first port that answers as ZMK Studio. */
async function open(ports: string[]): Promise<Session | null> {
  for (const path of ports) {
    let t: Awaited<ReturnType<typeof serialTransport>> | null = null;
    try {
      t = await serialTransport(path);
      const conn = create_rpc_connection(t.transport, { signal: t.transport.abortController.signal });
      const res = await withTimeout(call_rpc(conn, { core: { getDeviceInfo: true } }), 1500, "Studio");
      const name = res.core?.getDeviceInfo?.name;
      if (name !== undefined) return { conn, close: t.close, name };
    } catch {
      // Not a Studio port, or it didn't answer.
    }
    await t?.close();
  }
  return null;
}

async function lockState(conn: RpcConnection): Promise<number | undefined> {
  const res = await withTimeout(call_rpc(conn, { core: { getLockState: true } }), 1500, "Studio lock state");
  return res.core?.getLockState;
}

export interface StudioStatus {
  available: boolean;
  name: string | null;
  locked: boolean;
}

export async function studioStatus(ports: string[]): Promise<StudioStatus> {
  const s = await open(ports);
  if (!s) return { available: false, name: null, locked: true };
  try {
    return { available: true, name: s.name, locked: (await lockState(s.conn)) !== UNLOCKED };
  } finally {
    await s.close();
  }
}

export interface StudioBinding {
  behaviorId: number;
  param1: number;
  param2: number;
}

export interface StudioLayer {
  id: number;
  name: string;
  bindings: StudioBinding[];
}

export interface ImportedLayout {
  layers: Omit<Layer, "node">[];
  /** Keys Tandem couldn't translate, left empty. */
  unknown: string[];
}

const BT = ["BT_CLR", "BT_NXT", "BT_PRV", "BT_SEL", "BT_CLR_ALL", "BT_DISC"];
const OUT = ["OUT_TOG", "OUT_USB", "OUT_BLE"];

/** Turns one Studio binding into ZMK keymap syntax, or null if Tandem doesn't know it. */
export function studioToBinding(displayName: string, b: StudioBinding, layerIndex: (id: number) => number): string | null {
  const key = (usage: number) => usageToCode(usage) ?? `0x${usage.toString(16)}`;
  const layer = (id: number) => {
    const i = layerIndex(id);
    return i < 0 ? id : i;
  };
  switch (displayName.trim().toLowerCase()) {
    case "key press":
      return `&kp ${key(b.param1)}`;
    case "transparent":
      return "&trans";
    case "none":
      return "&none";
    case "momentary layer":
      return `&mo ${layer(b.param1)}`;
    case "toggle layer":
      return `&tog ${layer(b.param1)}`;
    case "to layer":
      return `&to ${layer(b.param1)}`;
    case "layer-tap":
    case "layer tap":
      return `&lt ${layer(b.param1)} ${key(b.param2)}`;
    case "mod-tap":
    case "mod tap":
      return `&mt ${key(b.param1)} ${key(b.param2)}`;
    case "sticky key":
      return `&sk ${key(b.param1)}`;
    case "sticky layer":
      return `&sl ${layer(b.param1)}`;
    case "bluetooth": {
      const cmd = BT[b.param1];
      if (!cmd) return null;
      return cmd === "BT_SEL" || cmd === "BT_DISC" ? `&bt ${cmd} ${b.param2}` : `&bt ${cmd}`;
    }
    case "output selection":
    case "outputs":
      return OUT[b.param1] ? `&out ${OUT[b.param1]}` : null;
    case "bootloader":
      return "&bootloader";
    case "reset":
    case "system reset":
      return "&sys_reset";
    case "studio unlock":
      return "&studio_unlock";
    case "caps word":
      return "&caps_word";
    case "key repeat":
      return "&key_repeat";
    case "underglow":
    case "rgb underglow":
      return b.param2 ? `&rgb_ug ${b.param1} ${b.param2}` : `&rgb_ug ${b.param1}`;
    case "backlight":
      return b.param2 ? `&bl ${b.param1} ${b.param2}` : `&bl ${b.param1}`;
    case "external power":
      return `&ext_power ${b.param1}`;
    default:
      return null;
  }
}

export function convertStudioKeymap(layers: StudioLayer[], behaviorNames: Map<number, string>): ImportedLayout {
  const unknown: string[] = [];
  const index = (id: number) => layers.findIndex((l) => l.id === id);
  return {
    layers: layers.map((l, i) => {
      const name = l.name.trim() || (i === 0 ? "Base" : `Layer ${i}`);
      return {
        name,
        bindings: l.bindings.map((b, k) => {
          const display = behaviorNames.get(b.behaviorId) ?? `behavior ${b.behaviorId}`;
          const text = studioToBinding(display, b, index);
          if (text) return text;
          unknown.push(`${name}, key ${k + 1}: ${display}`);
          return "&none";
        }),
      };
    }),
    unknown,
  };
}

/**
 * Reads the keymap, waiting up to `waitMs` for the user to unlock the
 * keyboard. Calls `onLocked` once if it has to wait.
 */
export async function readStudioLayout(ports: string[], waitMs: number, onLocked?: () => void): Promise<ImportedLayout> {
  const s = await open(ports);
  if (!s) throw new Error("The keyboard didn't answer over ZMK Studio.");
  try {
    if ((await lockState(s.conn)) === LOCKED) {
      onLocked?.();
      const deadline = Date.now() + waitMs;
      while ((await lockState(s.conn)) !== UNLOCKED) {
        if (Date.now() > deadline) throw new Error("The keyboard stayed locked. Press its Studio unlock key and try again.");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const keymap = (await withTimeout(call_rpc(s.conn, { keymap: { getKeymap: true } }), 5000, "Reading the keymap")).keymap?.getKeymap;
    if (!keymap) throw new Error("The keyboard didn't send its keymap.");

    const ids = (await withTimeout(call_rpc(s.conn, { behaviors: { listAllBehaviors: true } }), 3000, "Listing behaviors")).behaviors
      ?.listAllBehaviors?.behaviors ?? [];
    const names = new Map<number, string>();
    for (const id of ids) {
      const details = (await withTimeout(call_rpc(s.conn, { behaviors: { getBehaviorDetails: { behaviorId: id } } }), 3000, "Behavior details"))
        .behaviors?.getBehaviorDetails;
      if (details) names.set(id, details.displayName);
    }

    return convertStudioKeymap(keymap.layers, names);
  } finally {
    await s.close();
  }
}
