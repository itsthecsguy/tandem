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

// Command numbers as Kinesis's ZMK fork defines them in dt-bindings/zmk/*.h.
// &bl and &rgb_ug take two parameters, and the names below without a
// parameter of their own expand to the command and a 0.
const BT = ["BT_CLR", "BT_NXT", "BT_PRV", "BT_SEL", "BT_CLR_ALL", "BT_DISC"];
const OUT = ["OUT_TOG", "OUT_USB", "OUT_BLE"];
const BL = ["BL_ON", "BL_OFF", "BL_TOG", "BL_INC", "BL_DEC", "BL_CYCLE"];
const BL_SET = 6;
const RGB = ["RGB_TOG", "RGB_ON", "RGB_OFF", "RGB_HUI", "RGB_HUD", "RGB_SAI", "RGB_SAD", "RGB_BRI", "RGB_BRD", "RGB_SPI", "RGB_SPD", "RGB_EFF", "RGB_EFR"];
const EP = ["EP_OFF", "EP_ON", "EP_TOG"];

/**
 * Behaviors without parameters that Kinesis's config defines, by the name
 * Studio shows for them: macro_ver from bin/get_version.sh, which has no
 * display name, and the macros in macros.dtsi (see behaviorLabels).
 */
export const KINESIS_LABELS = new Map([["macro_ver", "macro_ver"]]);

/**
 * Labels of the parameterless behaviors in a .dtsi file, by every name Studio
 * might show for them: the display name, the legacy label, or the node label.
 */
export function behaviorLabels(dtsi: string): Map<string, string> {
  const labels = new Map<string, string>();
  for (const m of dtsi.matchAll(/([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)\s*\{([^{}]*)/g)) {
    const [, label, node, body] = m;
    if (!/#binding-cells\s*=\s*<0>/.test(body)) continue;
    labels.set(label.toLowerCase(), label);
    labels.set(node.toLowerCase(), label);
    for (const prop of ["display-name", "label"]) {
      const value = new RegExp(`${prop}\\s*=\\s*"([^"]+)"`).exec(body)?.[1];
      if (value) labels.set(value.trim().toLowerCase(), label);
    }
  }
  return labels;
}

/** Turns one Studio binding into ZMK keymap syntax, or null if Tandem doesn't know it. */
export function studioToBinding(
  displayName: string,
  b: StudioBinding,
  layerIndex: (id: number) => number,
  labels: Map<string, string> = KINESIS_LABELS,
): string | null {
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
      return RGB[b.param1] && !b.param2 ? `&rgb_ug ${RGB[b.param1]}` : `&rgb_ug ${b.param1} ${b.param2}`;
    case "backlight":
      if (b.param1 === BL_SET) return `&bl BL_SET ${b.param2}`;
      return BL[b.param1] && !b.param2 ? `&bl ${BL[b.param1]}` : `&bl ${b.param1} ${b.param2}`;
    case "external power":
      return `&ext_power ${EP[b.param1] ?? b.param1}`;
    case "battery level":
      // Kinesis's &stp, whose one command so far is STP_BAT.
      return `&stp ${b.param1 === 0 ? "STP_BAT" : b.param1}`;
    default: {
      const label = labels.get(displayName.trim().toLowerCase());
      return label && !b.param1 && !b.param2 ? `&${label}` : null;
    }
  }
}

export function convertStudioKeymap(
  layers: StudioLayer[],
  behaviorNames: Map<number, string>,
  labels: Map<string, string> = KINESIS_LABELS,
): ImportedLayout {
  const unknown: string[] = [];
  const index = (id: number) => layers.findIndex((l) => l.id === id);
  return {
    layers: layers.map((l, i) => {
      const name = l.name.trim() || (i === 0 ? "Base" : `Layer ${i}`);
      return {
        name,
        bindings: l.bindings.map((b, k) => {
          const display = behaviorNames.get(b.behaviorId) ?? `behavior ${b.behaviorId}`;
          const text = studioToBinding(display, b, index, labels);
          if (text) return text;
          unknown.push(`${name}, key ${k + 1}: ${display}`);
          return "&none";
        }),
      };
    }),
    unknown,
  };
}
