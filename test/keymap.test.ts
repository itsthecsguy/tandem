import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatBinding, parseBinding } from "../shared/bindings";
import { importKeymap, parseKeymap, toKeymap, writeKeymap } from "../shared/keymap";
import { readLayout } from "../shared/layout";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const keymapText = fixture("adv360.keymap");
const { rows, keys } = readLayout(fixture("info.json"));

// Everything except layer bindings and Tandem's block, with whitespace squashed.
function skeleton(text: string): string {
  return text
    .replace(/\/\* tandem:begin \*\/[\s\S]*?\/\* tandem:end \*\//, "")
    .replace(/bindings\s*=\s*<[^>]*>/g, "bindings = <>")
    .replace(/\s+/g, " ");
}

describe("layout", () => {
  it("reads 76 keys in five rows", () => {
    expect(keys).toHaveLength(76);
    expect(rows).toEqual([14, 14, 18, 14, 16]);
  });
});

describe("parseKeymap", () => {
  const parsed = parseKeymap(keymapText);

  it("finds every layer with one binding per key", () => {
    expect(parsed.layers.map((l) => l.name)).toEqual(["Base", "Keypad", "Fn", "Mod", "Layer 4"]);
    for (const layer of parsed.layers) expect(layer.bindings).toHaveLength(76);
  });

  it("reads bindings with arguments", () => {
    const base = parsed.layers[0].bindings;
    expect(base[65]).toBe("&lt 4 BACKSPACE");
    expect(base[39]).toBe("&kp LC(LS(TAB))");
    expect(parsed.layers[3].bindings[1]).toBe("&bt BT_SEL 0");
  });

  it("finds the global &lt quick-tap override", () => {
    expect(parsed.ltOverride?.quickTapMs).toBe(200);
  });
});

describe("writeKeymap", () => {
  it("leaves the file alone apart from bindings and Tandem's block", () => {
    const keymap = toKeymap(parseKeymap(keymapText));
    const out = writeKeymap(keymapText, keymap, rows);
    expect(skeleton(out)).toBe(skeleton(keymapText));
    expect(toKeymap(parseKeymap(out)).layers).toEqual(keymap.layers);
  });

  it("changes only the edited key", () => {
    const keymap = toKeymap(parseKeymap(keymapText));
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    const after = toKeymap(parseKeymap(writeKeymap(keymapText, keymap, rows)));
    const before = toKeymap(parseKeymap(keymapText));
    before.layers[0].bindings[15] = "&ltr 2 Q";
    expect(after.layers).toEqual(before.layers);
  });

  it("keeps the spacing of layers it didn't change", () => {
    const stock = readFileSync(join(__dirname, "..", "template", "config", "adv360.keymap"), "utf8");
    const keymap = toKeymap(parseKeymap(stock));
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    const out = writeKeymap(stock, keymap, rows);
    const layerText = (text: string, i: number) => {
      const { content } = parseKeymap(text).layers[i];
      return text.slice(content.start, content.end);
    };
    expect(layerText(out, 0)).not.toBe(layerText(stock, 0));
    for (const i of [1, 2, 3]) expect(layerText(out, i)).toBe(layerText(stock, i));
  });

  it("is stable when written twice", () => {
    const keymap = toKeymap(parseKeymap(keymapText));
    const once = writeKeymap(keymapText, keymap, rows);
    expect(writeKeymap(once, toKeymap(parseKeymap(once)), rows)).toBe(once);
  });

  it("writes repeat timing into the managed block and reads it back", () => {
    const keymap = toKeymap(parseKeymap(keymapText));
    keymap.repeat = { tappingTermMs: 180, quickTapMs: 150 };
    const out = writeKeymap(keymapText, keymap, rows);
    expect(out).toContain("ltr: layer_tap_repeat {");
    expect(parseKeymap(out).repeat).toEqual({ tappingTermMs: 180, quickTapMs: 150 });
  });
});

describe("importKeymap", () => {
  const { text, notes } = importKeymap(keymapText, rows);
  const parsed = parseKeymap(text);

  it("turns the backspace layer-tap into Tandem's repeat behavior", () => {
    expect(parsed.layers[0].bindings[65]).toBe("&ltr 4 BACKSPACE");
    expect(parsed.repeat.quickTapMs).toBe(200);
    expect(notes[0]).toMatch(/Converted 1 layer-tap key/);
  });

  it("drops the global override", () => {
    expect(parsed.ltOverride).toBeNull();
    expect(text).not.toMatch(/&lt\s*\{/);
  });

  it("does nothing more on a second import", () => {
    expect(importKeymap(text, rows).text).toBe(text);
  });
});

describe("bindings", () => {
  it("round-trips every binding in the keymap", () => {
    for (const layer of parseKeymap(keymapText).layers) {
      for (const b of layer.bindings) expect(formatBinding(parseBinding(b))).toBe(b);
    }
  });

  it("recognizes Tandem's behaviors", () => {
    expect(parseBinding("&ltr 4 BACKSPACE")).toEqual({ kind: "ltr", layer: 4, key: "BACKSPACE" });
    expect(parseBinding("&mtr LEFT_SHIFT A")).toEqual({ kind: "mtr", mod: "LEFT_SHIFT", key: "A" });
  });
});
