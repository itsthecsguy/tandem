import { keyFace, parseBinding } from "../../shared/bindings";
import type { Keymap } from "../../shared/types";

export type ActivatorKind = "hold" | "toggle" | "goto" | "sticky";

export interface Activator {
  /** Key position that turns the layer on. */
  key: number;
  /** Layer that key is on. */
  from: number;
  kind: ActivatorKind;
  /** The key's label on the layer it's on. */
  label: string;
}

/** Which keys turn each layer on. Keys on the base layer come first. */
export function layerActivators(keymap: Keymap): Activator[][] {
  const names = keymap.layers.map((l) => l.name);
  const result: Activator[][] = keymap.layers.map(() => []);

  keymap.layers.forEach((layer, from) => {
    layer.bindings.forEach((text, key) => {
      const b = parseBinding(text);
      let target: number | null = null;
      let kind: ActivatorKind = "hold";
      if (b.kind === "mo" || b.kind === "lt" || b.kind === "ltr") target = b.layer;
      else if (b.kind === "tog") (target = b.layer), (kind = "toggle");
      else if (b.kind === "to") (target = b.layer), (kind = "goto");
      else if (b.kind === "raw") {
        const sl = /^&sl (\d+)$/.exec(b.text);
        if (sl) (target = Number(sl[1])), (kind = "sticky");
      }
      if (target === null || target === from || !result[target]) return;
      // A layer's own activator repeated on that layer adds nothing.
      if (result[target].some((a) => a.key === key && a.kind === kind)) return;
      const face = keyFace(b, names);
      const label = b.kind === "lt" || b.kind === "ltr" ? face.tap : names[target];
      result[target].push({ key, from, kind, label });
    });
  });

  return result.map((list) => list.sort((a, b) => a.from - b.from));
}

export const ACTIVATOR_VERB: Record<ActivatorKind, string> = {
  hold: "Hold",
  toggle: "Tap to toggle",
  goto: "Tap to switch",
  sticky: "Tap once",
};

/** A short description for the layer bar, like "Hold ⌫" or "Tap to toggle". */
export function activatorSummary(list: Activator[]): { verb: string; keys: string[] } | null {
  const fromBase = list.filter((a) => a.from === 0);
  const pick = fromBase.length ? fromBase : list;
  if (!pick.length) return null;
  const kind = pick[0].kind;
  const keys = [...new Set(pick.filter((a) => a.kind === kind).map((a) => a.label))];
  return { verb: ACTIVATOR_VERB[kind], keys };
}

/** CSS color for a layer. The base layer has none. */
export function layerColor(index: number): string | undefined {
  return index === 0 ? undefined : `var(--layer-${((index - 1) % 8) + 1})`;
}
