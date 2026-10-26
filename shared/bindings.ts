import { keyLabel, sameKey } from "./keycodes";

// A ZMK binding such as "&lt 4 BACKSPACE", in a shape the editor can work with.
export type Binding =
  | { kind: "kp"; key: string }
  | { kind: "ltr"; layer: number; key: string }
  | { kind: "mtr"; mod: string; key: string }
  | { kind: "lt"; layer: number; key: string }
  | { kind: "mt"; mod: string; key: string }
  | { kind: "mo"; layer: number }
  | { kind: "tog"; layer: number }
  | { kind: "to"; layer: number }
  | { kind: "trans" }
  | { kind: "none" }
  | { kind: "raw"; text: string };

export type BindingKind = Binding["kind"];

export interface BehaviorInfo {
  kind: BindingKind;
  title: string;
  description: string;
  /** Tandem's own behaviors, shown first. */
  featured?: boolean;
}

export const BEHAVIORS: BehaviorInfo[] = [
  { kind: "kp", title: "Key", description: "Sends one key or shortcut." },
  {
    kind: "ltr",
    title: "Hold for layer, tap twice to repeat",
    description: "Tap sends the key. Hold switches layer. Tap, then press and hold, repeats the key.",
    featured: true,
  },
  {
    kind: "mtr",
    title: "Hold for modifier, tap twice to repeat",
    description: "Tap sends the key. Hold acts as a modifier. Tap, then press and hold, repeats the key.",
    featured: true,
  },
  { kind: "lt", title: "Hold for layer", description: "Tap sends the key. Hold switches layer." },
  { kind: "mt", title: "Hold for modifier", description: "Tap sends the key. Hold acts as a modifier." },
  { kind: "mo", title: "Layer while held", description: "Switches layer until you let go." },
  { kind: "tog", title: "Toggle layer", description: "Turns a layer on or off." },
  { kind: "to", title: "Go to layer", description: "Switches to a layer and stays there." },
  { kind: "trans", title: "Transparent", description: "Uses whatever the layer below has here." },
  { kind: "none", title: "Nothing", description: "Does nothing." },
  { kind: "raw", title: "Custom binding", description: "Any ZMK binding, typed by hand." },
];

const int = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);

export function parseBinding(text: string): Binding {
  const parts = text.trim().split(/\s+/);
  const name = parts[0]?.replace(/^&/, "");
  const [a, b] = [parts[1], parts.slice(2).join(" ") || undefined];

  switch (name) {
    case "kp":
      if (parts.length >= 2) return { kind: "kp", key: parts.slice(1).join(" ") };
      break;
    case "ltr":
    case "lt": {
      const layer = int(a);
      if (layer !== null && b) return { kind: name, layer, key: b };
      break;
    }
    case "mtr":
    case "mt":
      if (a && b) return { kind: name, mod: a, key: b };
      break;
    case "mo":
    case "tog":
    case "to": {
      const layer = int(a);
      if (layer !== null && parts.length === 2) return { kind: name, layer };
      break;
    }
    case "trans":
      if (parts.length === 1) return { kind: "trans" };
      break;
    case "none":
      if (parts.length === 1) return { kind: "none" };
      break;
  }
  return { kind: "raw", text: text.trim() };
}

export function formatBinding(b: Binding): string {
  switch (b.kind) {
    case "kp":
      return `&kp ${b.key}`;
    case "ltr":
    case "lt":
      return `&${b.kind} ${b.layer} ${b.key}`;
    case "mtr":
    case "mt":
      return `&${b.kind} ${b.mod} ${b.key}`;
    case "mo":
    case "tog":
    case "to":
      return `&${b.kind} ${b.layer}`;
    case "trans":
      return "&trans";
    case "none":
      return "&none";
    case "raw":
      return b.text.startsWith("&") ? b.text : `&${b.text}`;
  }
}

export interface KeyFace {
  /** Big label: what a tap does. */
  tap: string;
  /** Small label: what a hold does, if anything. */
  hold?: string;
  /** Tap-then-hold repeats the key. */
  repeat?: boolean;
  muted?: boolean;
}

const RAW_LABELS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^&bt BT_SEL (\d+)$/, (m) => `BT ${m[1]}`],
  [/^&bt BT_CLR$/, () => "BT clear"],
  [/^&bt BT_NXT$/, () => "BT next"],
  [/^&bt BT_PRV$/, () => "BT prev"],
  [/^&out OUT_USB$/, () => "USB"],
  [/^&out OUT_BLE$/, () => "BLE"],
  [/^&out OUT_TOG$/, () => "Output"],
  [/^&bootloader$/, () => "Boot"],
  [/^&sys_reset$/, () => "Reset"],
  [/^&rgb_ug RGB_TOG$/, () => "RGB"],
  [/^&rgb_ug /, () => "RGB fx"],
  [/^&bl BL_TOG$/, () => "Light"],
  [/^&bl BL_INC$/, () => "Light+"],
  [/^&bl BL_DEC$/, () => "Light−"],
  [/^&bl /, () => "Light"],
  [/^&macro_ver$/, () => "Version"],
  [/^&studio_unlock$/, () => "Unlock"],
  [/^&caps_word$/, () => "CapsWd"],
  [/^&key_repeat$/, () => "Repeat"],
  [/^&hm (\S+) (.+)$/, (m) => `${keyLabel(m[2])}`],
];

export function keyFace(b: Binding, layerNames: string[]): KeyFace {
  const layer = (n: number) => layerNames[n] ?? `Layer ${n}`;
  switch (b.kind) {
    case "kp":
      return { tap: keyLabel(b.key) };
    case "ltr":
      return { tap: keyLabel(b.key), hold: layer(b.layer), repeat: true };
    case "lt":
      return { tap: keyLabel(b.key), hold: layer(b.layer) };
    case "mtr":
      return { tap: keyLabel(b.key), hold: keyLabel(b.mod), repeat: true };
    case "mt":
      return { tap: keyLabel(b.key), hold: keyLabel(b.mod) };
    case "mo":
      return { tap: layer(b.layer), hold: "hold" };
    case "tog":
      return { tap: layer(b.layer), hold: "toggle" };
    case "to":
      return { tap: layer(b.layer), hold: "go to" };
    case "trans":
      return { tap: "▽", muted: true };
    case "none":
      return { tap: "", muted: true };
    case "raw": {
      for (const [re, label] of RAW_LABELS) {
        const m = re.exec(b.text);
        if (m) return { tap: label(m) };
      }
      return { tap: b.text.replace(/^&/, "").split(/\s+/)[0] };
    }
  }
}

/**
 * A binding after layer `removed` is deleted. ZMK numbers layers by order, so
 * later layers shift down one. A key that switched to the deleted layer keeps
 * its tap key if it has one, and otherwise does nothing.
 */
export function bindingAfterLayerRemoved(text: string, removed: number): string {
  const b = parseBinding(text);
  const shift = (n: number) => (n > removed ? n - 1 : n);
  switch (b.kind) {
    case "ltr":
    case "lt":
      return b.layer === removed ? formatBinding({ kind: "kp", key: b.key }) : formatBinding({ ...b, layer: shift(b.layer) });
    case "mo":
    case "tog":
    case "to":
      return b.layer === removed ? "&none" : formatBinding({ ...b, layer: shift(b.layer) });
    case "raw": {
      const sticky = /^&sl (\d+)$/.exec(b.text);
      if (!sticky) return text;
      const n = Number(sticky[1]);
      return n === removed ? "&none" : `&sl ${shift(n)}`;
    }
    default:
      return text;
  }
}

/** Layer a binding switches to, if it switches layers. */
export function targetLayer(b: Binding): number | null {
  return b.kind === "ltr" || b.kind === "lt" || b.kind === "mo" || b.kind === "tog" || b.kind === "to" ? b.layer : null;
}

/** One sentence describing what a key does, for tooltips. */
export function describeBinding(b: Binding, layerNames: string[]): string {
  const layer = (n: number) => layerNames[n] ?? `layer ${n}`;
  switch (b.kind) {
    case "kp":
      return keyLabel(b.key);
    case "ltr":
      return `Tap ${keyLabel(b.key)}, hold for ${layer(b.layer)}, tap then hold to repeat`;
    case "lt":
      return `Tap ${keyLabel(b.key)}, hold for ${layer(b.layer)}`;
    case "mtr":
      return `Tap ${keyLabel(b.key)}, hold for ${keyLabel(b.mod)}, tap then hold to repeat`;
    case "mt":
      return `Tap ${keyLabel(b.key)}, hold for ${keyLabel(b.mod)}`;
    case "mo":
      return `Hold for ${layer(b.layer)}`;
    case "tog":
      return `Toggle ${layer(b.layer)}`;
    case "to":
      return `Switch to ${layer(b.layer)}`;
    case "trans":
      return "Transparent: uses the layer below";
    case "none":
      return "Does nothing";
    case "raw":
      return b.text;
  }
}

/** Swap a binding to another kind, keeping its key and layer where they fit. */
export function convertBinding(b: Binding, kind: BindingKind, fallbackLayer: number): Binding {
  const key = "key" in b ? b.key : "A";
  const layer = "layer" in b ? b.layer : fallbackLayer;
  const mod = "mod" in b ? b.mod : "LEFT_SHIFT";
  switch (kind) {
    case "kp":
      return { kind, key };
    case "ltr":
    case "lt":
      return { kind, layer, key };
    case "mtr":
    case "mt":
      return { kind, mod, key };
    case "mo":
    case "tog":
    case "to":
      return { kind, layer };
    case "trans":
    case "none":
      return { kind };
    case "raw":
      return { kind, text: formatBinding(b) };
  }
}

/** True when two bindings do the same thing, e.g. "&kp UNDER" and "&kp UNDERSCORE". */
export function sameBinding(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const x = parseBinding(a);
  const y = parseBinding(b);
  if (x.kind !== y.kind || x.kind === "raw" || y.kind === "raw") return false;
  const fields = (v: Binding) => v as Record<string, string | number>;
  return Object.keys(fields(x)).every((k) => {
    const [p, q] = [fields(x)[k], fields(y)[k]];
    return typeof p === "string" && typeof q === "string" ? sameKey(p, q) : p === q;
  });
}
