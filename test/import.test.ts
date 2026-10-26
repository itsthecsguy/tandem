import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { usageToCode } from "../shared/hid";
import { parseKeymap, replaceLayers } from "../shared/keymap";
import { readLayout } from "../shared/layout";
import { behaviorLabels, convertStudioKeymap, studioToBinding } from "../shared/studio";

const usage = (page: number, id: number, mods = 0) => ((mods << 24) | (page << 16) | id) >>> 0;
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("usageToCode", () => {
  it("names keyboard keys", () => {
    expect(usageToCode(usage(7, 0x04))).toBe("A");
    expect(usageToCode(usage(7, 0x1e))).toBe("N1");
    expect(usageToCode(usage(7, 0x2a))).toBe("BACKSPACE");
    expect(usageToCode(usage(7, 0xe1))).toBe("LEFT_SHIFT");
    expect(usageToCode(usage(7, 0x45))).toBe("F12");
  });

  it("names media keys", () => {
    expect(usageToCode(usage(0x0c, 0xe9))).toBe("C_VOLUME_UP");
  });

  it("wraps modifiers and names shifted symbols", () => {
    expect(usageToCode(usage(7, 0x1e, 0x02))).toBe("EXCLAMATION");
    expect(usageToCode(usage(7, 0x31, 0x0a))).toBe("LS(LG(BACKSLASH))");
  });

  it("returns null for usages it doesn't know", () => {
    expect(usageToCode(usage(0x09, 1))).toBeNull();
  });
});

describe("studioToBinding", () => {
  const layerIndex = (id: number) => [10, 11, 12].indexOf(id);

  it("converts common behaviors", () => {
    expect(studioToBinding("Key Press", { behaviorId: 1, param1: usage(7, 0x04), param2: 0 }, layerIndex)).toBe("&kp A");
    expect(studioToBinding("Layer-Tap", { behaviorId: 2, param1: 12, param2: usage(7, 0x2a) }, layerIndex)).toBe("&lt 2 BACKSPACE");
    expect(studioToBinding("Momentary Layer", { behaviorId: 3, param1: 11, param2: 0 }, layerIndex)).toBe("&mo 1");
    expect(studioToBinding("Bluetooth", { behaviorId: 4, param1: 3, param2: 2 }, layerIndex)).toBe("&bt BT_SEL 2");
    expect(studioToBinding("Transparent", { behaviorId: 5, param1: 0, param2: 0 }, layerIndex)).toBe("&trans");
    expect(studioToBinding("Studio Unlock", { behaviorId: 6, param1: 0, param2: 0 }, layerIndex)).toBe("&studio_unlock");
  });

  it("gives backlight and underglow both their parameters, by name where ZMK has one", () => {
    // &bl and &rgb_ug take two cells. One alone makes the devicetree read the next number as a node.
    expect(studioToBinding("Backlight", { behaviorId: 7, param1: 2, param2: 0 }, layerIndex)).toBe("&bl BL_TOG");
    expect(studioToBinding("Backlight", { behaviorId: 7, param1: 3, param2: 0 }, layerIndex)).toBe("&bl BL_INC");
    expect(studioToBinding("Backlight", { behaviorId: 7, param1: 6, param2: 40 }, layerIndex)).toBe("&bl BL_SET 40");
    expect(studioToBinding("Underglow", { behaviorId: 8, param1: 0, param2: 0 }, layerIndex)).toBe("&rgb_ug RGB_TOG");
    expect(studioToBinding("Underglow", { behaviorId: 8, param1: 15, param2: 0x10ff80 }, layerIndex)).toBe(`&rgb_ug 15 ${0x10ff80}`);
    expect(studioToBinding("External Power", { behaviorId: 9, param1: 2, param2: 0 }, layerIndex)).toBe("&ext_power EP_TOG");
  });

  it("knows Kinesis's own keys", () => {
    expect(studioToBinding("Battery Level", { behaviorId: 10, param1: 0, param2: 0 }, layerIndex)).toBe("&stp STP_BAT");
    expect(studioToBinding("macro_ver", { behaviorId: 11, param1: 0, param2: 0 }, layerIndex)).toBe("&macro_ver");
    const labels = behaviorLabels(readFileSync(join(__dirname, "..", "template/config/macros.dtsi"), "utf8"));
    expect(studioToBinding("Windows Cut", { behaviorId: 12, param1: 0, param2: 0 }, layerIndex, labels)).toBe("&Win_Cut");
    expect(studioToBinding("macro_quotes", { behaviorId: 13, param1: 0, param2: 0 }, layerIndex, labels)).toBe("&macro_quotes");
  });

  it("returns null for behaviors it doesn't know", () => {
    expect(studioToBinding("Homerow Mods", { behaviorId: 9, param1: 0, param2: 0 }, layerIndex)).toBeNull();
  });
});

describe("convertStudioKeymap and replaceLayers", () => {
  const { rows } = readLayout(fixture("info.json"));
  const names = new Map([
    [1, "Key Press"],
    [2, "Momentary Layer"],
    [3, "Mystery"],
  ]);
  const keys = (n: number, b: { behaviorId: number; param1: number; param2: number }) => Array.from({ length: n }, () => b);
  const studio = [
    { id: 7, name: "", bindings: keys(76, { behaviorId: 1, param1: usage(7, 0x04), param2: 0 }) },
    { id: 9, name: "Symbols", bindings: [{ behaviorId: 2, param1: 7, param2: 0 }, { behaviorId: 3, param1: 0, param2: 0 }, ...keys(74, { behaviorId: 1, param1: usage(7, 0x05), param2: 0 })] },
  ];
  const imported = convertStudioKeymap(studio, names);

  it("names layers and reports keys it couldn't convert", () => {
    expect(imported.layers.map((l) => l.name)).toEqual(["Base", "Symbols"]);
    expect(imported.layers[1].bindings.slice(0, 2)).toEqual(["&mo 0", "&none"]);
    expect(imported.unknown).toEqual(["Symbols, key 2: Mystery"]);
  });

  it("writes the layers into a keymap file that reads back the same", () => {
    const text = replaceLayers(fixture("adv360.keymap"), imported.layers, rows);
    const parsed = parseKeymap(text);
    expect(parsed.layers.map((l) => [l.node, l.name])).toEqual([
      ["default_layer", "Base"],
      ["layer_symbols", "Symbols"],
    ]);
    expect(parsed.layers[1].bindings).toEqual(imported.layers[1].bindings);
    // Behaviors and macros outside the keymap node are untouched.
    expect(text).toContain("homerow_mods");
  });
});
