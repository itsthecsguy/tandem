import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseKeymap, toKeymap } from "../shared/keymap";
import type { JobEvent } from "../shared/types";
import { viewJob } from "../src/lib/job";
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

describe("viewJob's setup checklist", () => {
  const view = (events: JobEvent[]) => viewJob({ id: "j", running: true, events });

  it("marks each half's steps as the setup reaches them", () => {
    const v = view([
      { type: "manual", side: "right", reason: "no-autoflash" },
      { type: "update-port", side: "right" },
    ]);
    expect(v.setup).toBe(true);
    expect(v.hands.right).toMatchObject({ keys: "now", allow: "now", port: "todo" });
    expect(v.hands.left).toMatchObject({ keys: "todo", allow: "todo", port: "todo" });

    const next = view([
      { type: "manual", side: "right", reason: "no-autoflash" },
      { type: "update-port", side: "right" },
      { type: "update-port-done", side: "right" },
      { type: "manual-done", side: "right" },
      { type: "grant-port", side: "right" },
    ]);
    expect(next.hands.right).toMatchObject({ keys: "done", allow: "done", port: "now" });
  });

  it("moves the finished steps to the half that went into update mode instead", () => {
    const v = view([
      { type: "manual", side: "right", reason: "no-autoflash" },
      { type: "update-port", side: "right" },
      { type: "update-port-done", side: "right" },
      { type: "manual-done", side: "right" },
      { type: "switched", from: "right", to: "left" },
    ]);
    expect(v.switched).toEqual({ from: "right", to: "left" });
    expect(v.hands.left).toMatchObject({ keys: "done", allow: "done" });
    expect(v.hands.right).toMatchObject({ keys: "todo", allow: "todo" });
  });

  it("checks off a half that finished without asking, and clears what was in progress on an error", () => {
    const v = view([
      { type: "step", step: "flash-right", state: "done", detail: "Running abc1234" },
      { type: "manual", side: "left", reason: "no-autoflash" },
      { type: "error", message: "Cancelled" },
    ]);
    expect(v.hands.right).toMatchObject({ keys: "done", allow: "done", port: "done" });
    expect(v.hands.left.keys).toBe("todo");
  });

  it("says when Tandem, not the user, put a half in update mode", () => {
    const v = view([
      { type: "manual", side: "left", reason: "no-autoflash" },
      { type: "manual-done", side: "left" },
      { type: "step", step: "flash-right", state: "active", detail: "Restarting into update mode through the left half" },
      { type: "update-port", side: "right" },
    ]);
    expect(v.hands.left).toMatchObject({ keys: "done", keysBy: "you" });
    expect(v.hands.right).toMatchObject({ keys: "done", keysBy: "tandem", allow: "now" });
  });

  it("leaves a freshly flashed half's new port for the end", () => {
    const v = view([
      { type: "manual", side: "right", reason: "no-autoflash" },
      { type: "update-port", side: "right" },
      { type: "update-port-done", side: "right" },
      { type: "manual-done", side: "right" },
      { type: "step", step: "flash-right", state: "done", detail: "Firmware sent" },
    ]);
    expect(v.hands.right).toMatchObject({ keys: "done", allow: "done", port: "todo" });
  });
});
