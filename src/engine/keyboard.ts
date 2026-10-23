// How the browser engine reaches the keyboard. With Web Serial it talks to the
// halves directly (see serial-keyboard.ts). Without it, there's no keyboard to
// see, and updates hand the firmware files to the user.

import type { DevicesStatus, HalfStatus, ImportedLayout, JobAction, KeyboardInfo, Side } from "../../shared/types";
import type { Flash } from "./jobs";
import { KINESIS_LAYOUT } from "./kinesis";
import { manualFlash } from "./manual";
import { answer } from "./prompts";

export interface KeyboardAccess {
  /** It can see the halves, and copy firmware onto them by itself. */
  caps: { keyboard: boolean; flash: boolean };
  devices(): DevicesStatus;
  /** Calls `listener` whenever a half connects, disconnects or changes firmware. */
  watch(listener: (devices: DevicesStatus) => void): () => void;
  info(): Promise<KeyboardInfo>;
  /** Reads the layout from the left half. */
  readLayout(): Promise<{ layout: ImportedLayout; keymapText?: string }>;
  /** Asks for access to a port. Must run inside a click. */
  connect(): Promise<void>;
  flash: Flash;
  /** Answers something a running update asked for. Must run inside a click. */
  act(action: JobAction): Promise<void>;
}

export function emptyHalf(side: Side): HalfStatus {
  return { side, mode: "missing", serial: null, autoflash: false, build: null, repo: null, protocol: 0, port: null, volume: null, otherPorts: [] };
}

export function noKeyboard(): KeyboardAccess {
  const devices: DevicesStatus = {
    left: emptyHalf("left"),
    right: emptyHalf("right"),
    unknownBootloaders: [],
    needsAccess: false,
    scannedAt: new Date().toISOString(),
  };
  return {
    caps: { keyboard: false, flash: false },
    devices: () => devices,
    watch: () => () => {},
    info: async () => ({ ...devices, tandemKeymap: false, tandemRepo: null, studio: null, layout: KINESIS_LAYOUT.keys }),
    readLayout: async () => {
      throw new Error("This browser can't talk to the keyboard. Open Tandem in Chrome or Edge to read the layout on it.");
    },
    connect: async () => {
      throw new Error("This browser can't talk to the keyboard. Open Tandem in Chrome or Edge.");
    },
    flash: manualFlash,
    act: async (action) => {
      answer(action);
    },
  };
}
