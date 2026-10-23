// Turns a keymap read over ZMK Studio into keymap syntax. Both the browser and
// the helper read Studio; only the transport differs.

import { usageToCode } from "./hid";
import type { Layer } from "./types";

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
