import type { Keymap, LayoutKey, Side } from "../../shared/types";

export function sideOf(key: LayoutKey): Side {
  return key.x + key.w / 2 < 9 ? "left" : "right";
}

export interface Combo {
  /** Key to hold: the one that turns on the layer with the bootloader key. */
  hold: number;
  /** Key to press while holding. */
  press: number;
  layerName: string;
}

/**
 * Finds the keys that put a half into its bootloader with the current
 * keymap: a &bootloader key on that half, and the &mo key for its layer.
 */
export function bootloaderCombo(side: Side, keymap: Keymap, layout: LayoutKey[]): Combo | null {
  for (const [layerIndex, layer] of keymap.layers.entries()) {
    const press = layer.bindings.findIndex((b, i) => b === "&bootloader" && layout[i] && sideOf(layout[i]) === side);
    if (press < 0) continue;
    const hold = keymap.layers[0].bindings.findIndex((b) => b === `&mo ${layerIndex}`);
    if (hold < 0) continue;
    return { hold, press, layerName: layer.name };
  }
  return null;
}

export function keyDescription(key: LayoutKey): string {
  const thumb = key.r !== 0;
  return `${sideOf(key) === "left" ? "Left" : "Right"} ${thumb ? "thumb cluster" : "half"}`;
}
