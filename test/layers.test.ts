import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { addLayer, layerReferences, removeLayer, renameLayer } from "../shared/layers";
import { importKeymap, parseKeymap, toKeymap, writeKeymap } from "../shared/keymap";
import { readLayout } from "../shared/layout";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const { rows } = readLayout(fixture("info.json"));
// The imported fixture: backspace is &ltr 4 BACKSPACE, Mod is &mo 3, Keypad is &tog 1.
const text = importKeymap(fixture("adv360.keymap"), rows).text;
const keymap = toKeymap(parseKeymap(text));
const roundTrip = (k: typeof keymap) => toKeymap(parseKeymap(writeKeymap(text, k, rows)));

describe("adding a layer", () => {
  const added = addLayer(keymap, 76);
  const back = roundTrip(added);

  it("appends a transparent layer with a fresh name", () => {
    expect(added.layers.at(-1)).toMatchObject({ node: "layer_layer_5", name: "Layer 5" });
    expect(back.layers.map((l) => l.name)).toEqual(["Base", "Keypad", "Fn", "Mod", "Layer 4", "Layer 5"]);
    expect(back.layers[5].bindings.every((b) => b === "&trans")).toBe(true);
  });

  it("keeps the other layers as they were", () => {
    expect(back.layers.slice(0, 5)).toEqual(keymap.layers);
  });
});

describe("renaming a layer", () => {
  it("adds display-name to a layer that had none", () => {
    const out = writeKeymap(text, renameLayer(keymap, 2, "Function"), rows);
    expect(out).toMatch(/layer_fn \{\n\s+display-name = "Function";\n\s+bindings = </);
    expect(toKeymap(parseKeymap(out)).layers[2].name).toBe("Function");
  });

  it("replaces an existing display-name", () => {
    const once = writeKeymap(text, renameLayer(keymap, 2, "Function"), rows);
    const twice = writeKeymap(once, renameLayer(toKeymap(parseKeymap(once)), 2, "F keys"), rows);
    expect(twice.match(/display-name/g)).toHaveLength(1);
    expect(toKeymap(parseKeymap(twice)).layers[2].name).toBe("F keys");
  });
});

describe("removing a layer", () => {
  it("counts the keys that switch to it", () => {
    // Mod sits on Base, Keypad and Fn.
    expect(layerReferences(keymap, 3)).toBe(3);
    expect(layerReferences(keymap, 4)).toBe(1);
  });

  it("drops the node and renumbers later layers", () => {
    const removed = removeLayer(keymap, 3);
    const back = roundTrip(removed);
    expect(back.layers.map((l) => l.name)).toEqual(["Base", "Keypad", "Fn", "Layer 4"]);
    // The Mod key switched to the removed layer, so it does nothing now.
    expect(back.layers[0].bindings[7]).toBe("&none");
    // Backspace held for layer 4, which is now layer 3.
    expect(back.layers[0].bindings[65]).toBe("&ltr 3 BACKSPACE");
  });

  it("keeps a hold-for-layer key's tap when its layer goes", () => {
    expect(removeLayer(keymap, 4).layers[0].bindings[65]).toBe("&kp BACKSPACE");
  });

  it("leaves no extra blank lines behind", () => {
    const gaps = (t: string) => (t.match(/\n[ \t]*\n[ \t]*\n/g) ?? []).length;
    expect(gaps(writeKeymap(text, removeLayer(keymap, 2), rows))).toBe(gaps(text));
  });

  it("refuses to remove the base layer", () => {
    expect(() => removeLayer(keymap, 0)).toThrow();
  });
});

it("refuses to reorder layers", () => {
  const reordered = { ...keymap, layers: [keymap.layers[0], keymap.layers[2], keymap.layers[1], ...keymap.layers.slice(3)] };
  expect(() => writeKeymap(text, reordered, rows)).toThrow(/reordered/);
});
