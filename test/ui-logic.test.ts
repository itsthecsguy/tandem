import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseKeymap, toKeymap } from "../server/keymap";
import { zmkCode, zmkShortcut } from "../src/lib/keyEvents";
import { activatorSummary, layerActivators } from "../src/lib/layers";

const press = (code: string, mods: Partial<Record<"metaKey" | "altKey" | "ctrlKey" | "shiftKey", boolean>> = {}) => ({
  code,
  metaKey: false,
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...mods,
});

describe("zmkShortcut", () => {
  it("maps plain keys by physical position", () => {
    expect(zmkShortcut(press("KeyQ"))).toBe("Q");
    expect(zmkShortcut(press("Digit1"))).toBe("N1");
    expect(zmkShortcut(press("Backspace"))).toBe("BACKSPACE");
    expect(zmkShortcut(press("Numpad7"))).toBe("KP_N7");
  });

  it("names shifted symbols", () => {
    expect(zmkShortcut(press("Digit1", { shiftKey: true }))).toBe("EXCLAMATION");
    expect(zmkShortcut(press("BracketLeft", { shiftKey: true }))).toBe("LEFT_BRACE");
  });

  it("wraps other modifiers in macOS order", () => {
    expect(zmkShortcut(press("Backslash", { metaKey: true, shiftKey: true }))).toBe("LS(LG(BACKSLASH))");
    expect(zmkShortcut(press("KeyC", { ctrlKey: true, altKey: true }))).toBe("LC(LA(C))");
  });

  it("knows the modifiers themselves", () => {
    expect(zmkCode("AltLeft")).toBe("LEFT_ALT");
    expect(zmkCode("MetaRight")).toBe("RIGHT_GUI");
  });

  it("returns null for keys it doesn't know", () => {
    expect(zmkShortcut(press("Fn"))).toBeNull();
  });
});

describe("layerActivators", () => {
  const keymap = toKeymap(parseKeymap(readFileSync(join(__dirname, "fixtures", "adv360.keymap"), "utf8")));
  const activators = layerActivators(keymap);

  it("finds the keys that reach each layer from the base layer", () => {
    expect(activatorSummary(activators[1])).toEqual({ verb: "Tap to toggle", keys: ["Keypad"] });
    expect(activatorSummary(activators[2])).toEqual({ verb: "Hold", keys: ["Fn"] });
    expect(activatorSummary(activators[3])).toEqual({ verb: "Hold", keys: ["Mod"] });
    expect(activatorSummary(activators[4])).toEqual({ verb: "Hold", keys: ["⌫"] });
  });

  it("lists both Fn keys", () => {
    expect(activators[2].filter((a) => a.from === 0).map((a) => a.key)).toEqual([60, 75]);
  });

  it("gives the base layer no activators", () => {
    expect(activators[0]).toEqual([]);
  });
});
