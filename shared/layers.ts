import { bindingAfterLayerRemoved, parseBinding, targetLayer } from "./bindings";
import type { Keymap } from "./types";

/** ZMK tracks active layers in a 32-bit mask. */
export const MAX_LAYERS = 32;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** A devicetree node name for a new layer that no other layer uses. */
export function newLayerNode(keymap: Keymap, name: string): string {
  const used = new Set(keymap.layers.map((l) => l.node));
  const base = `layer_${slug(name) || keymap.layers.length}`;
  let node = base;
  for (let n = 2; used.has(node); n++) node = `${base}_${n}`;
  return node;
}

/** "Layer 5", or the next free number if that name is taken. */
export function newLayerName(keymap: Keymap): string {
  const names = new Set(keymap.layers.map((l) => l.name.toLowerCase()));
  let n = keymap.layers.length;
  while (names.has(`layer ${n}`)) n++;
  return `Layer ${n}`;
}

export function addLayer(keymap: Keymap, keyCount: number): Keymap {
  const name = newLayerName(keymap);
  return {
    ...keymap,
    layers: [...keymap.layers, { node: newLayerNode(keymap, name), name, bindings: new Array(keyCount).fill("&trans") }],
  };
}

export function renameLayer(keymap: Keymap, index: number, name: string): Keymap {
  return { ...keymap, layers: keymap.layers.map((l, i) => (i === index ? { ...l, name } : l)) };
}

export function removeLayer(keymap: Keymap, index: number): Keymap {
  if (index === 0) throw new Error("The base layer can't be removed");
  return {
    ...keymap,
    layers: keymap.layers
      .filter((_, i) => i !== index)
      .map((l) => ({ ...l, bindings: l.bindings.map((b) => bindingAfterLayerRemoved(b, index)) })),
  };
}

/** Keys on other layers that switch to `index`. */
export function layerReferences(keymap: Keymap, index: number): number {
  let count = 0;
  keymap.layers.forEach((l, i) => {
    if (i === index) return;
    for (const b of l.bindings) if (targetLayer(parseBinding(b)) === index || b === `&sl ${index}`) count++;
  });
  return count;
}
