// Updates over Web Serial against a simulated keyboard and an in-memory GitHub.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobEvent } from "../shared/types";
import { MODULE_FILES } from "../src/engine/module";
import type { DriveLike } from "../src/engine/serial-keyboard";
import type { Engine } from "../src/engine/types";
import { FakeGitHub } from "./fakes/github";
import { FakeDrive, FakeKeyboard, notADrive } from "./fakes/keyboard";

const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

function tandemRepo(): Record<string, string> {
  const files: Record<string, string> = {
    ".github/workflows/build.yml": read("template/.github/workflows/build.yml"),
    "config/adv360.keymap": read("template/config/adv360.keymap"),
    "config/info.json": read("template/config/info.json"),
  };
  for (const f of MODULE_FILES) files[f.path] = f.content;
  return files;
}

const TIMING = {
  savedDriveMs: 150,
  comebackMs: 600,
  newPortMs: 150,
  pollMs: 10,
  infoMs: 40,
  bootMs: 100,
  dfu: { pageEraseMs: 0, pageWriteMs: 0, ackMs: 300, minEraseMs: 0 },
};

let github: FakeGitHub;
let restore: () => void;

beforeEach(() => {
  github = new FakeGitHub();
  restore = github.install();
  github.addRepo("octocat", "adv360", tandemRepo());
});

afterEach(() => restore());

async function setup(kb: FakeKeyboard, pick?: () => DriveLike, savedDrive?: DriveLike) {
  vi.resetModules();
  const store = await import("../src/engine/store");
  store.saveToken({ token: "gho_test", scope: "public_repo workflow" });
  const { keyboardAccess } = await import("../src/engine/serial-keyboard");
  const { browserEngine } = await import("../src/engine/browser");
  const access = keyboardAccess({ serial: kb, pickDirectory: kb.picker(pick), timing: TIMING, loadDrive: async () => savedDrive ?? null });
  const engine = browserEngine(access);
  await engine.connect({ owner: "octocat", name: "adv360", branch: "main" });
  const events: JobEvent[] = [];
  engine.subscribe((e) => e.type === "job-event" && events.push(e.event));
  return { engine, access, events };
}

async function until<T>(check: () => T | undefined | false | null, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Pilot {
  /** Choose the drive instead of allowing update ports. */
  preferDrive?: boolean;
  /** Turn down Tandem's offer to allow a port before a key combo. */
  skipPortFirst?: boolean;
  /** For these key combo requests, counted from 0, press the combo on the other half. */
  wrongHalf?: number[];
  /** In Chrome's list, pick the first new port instead of the one Tandem names. */
  anyPort?: boolean;
}

/** Plays the user: does what each prompt asks, as it comes. */
function autopilot(engine: Engine, events: JobEvent[], kb: FakeKeyboard, pilot: Pilot = {}) {
  let seen = 0;
  let combos = 0;
  const later = (fn: () => unknown) => setTimeout(() => void Promise.resolve(fn()).catch(() => {}), 30);
  const timer = setInterval(() => {
    for (; seen < events.length; seen++) {
      const e = events[seen];
      if (e.type === "manual") kb[pilot.wrongHalf?.includes(combos++) ? (e.side === "left" ? "right" : "left") : e.side].pressCombo();
      if (e.type === "update-port") later(() => engine.act(pilot.preferDrive ? { type: "pick-drive", side: e.side } : { type: "grant-update-port", side: e.side }));
      if (e.type === "drive") later(() => engine.act({ type: "pick-drive", side: e.side }));
      if (e.type === "grant-port") {
        kb.lookingFor = pilot.anyPort ? null : e.side;
        engine.act({ type: "grant-port", side: e.side, skip: !!(e.before && pilot.skipPortFirst) });
      }
    }
  }, 5);
  return () => clearInterval(timer);
}

/** Runs an update while the autopilot answers prompts. Without a layout change, it reflashes the current commit. */
async function run(engine: Engine, events: JobEvent[], kb: FakeKeyboard, pilot: Pilot = {}, keymapChange = true) {
  const stop = autopilot(engine, events, kb, pilot);
  try {
    if (keymapChange) {
      const { keymap } = await engine.state();
      keymap.layers[0].bindings[15] = keymap.layers[0].bindings[15] === "&ltr 2 Q" ? "&kp Q" : "&ltr 2 Q";
      await engine.update(keymap);
    } else {
      github.build(github.head("octocat", "adv360"));
      await engine.update();
    }
    return await until(() => events.find((e) => e.type === "done" || e.type === "error"), 6000);
  } finally {
    stop();
  }
}

const sides = (events: JobEvent[], type: JobEvent["type"]) => events.filter((e) => e.type === type).map((e) => ("side" in e ? e.side : null));

describe("Web Serial keyboard", () => {
  it("sees which halves run Tandem firmware", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234", studio: true }, right: { build: "old1234" } });
    kb.allowAll();
    const { access } = await setup(kb);
    await until(() => access.devices().right.autoflash);
    const d = access.devices();
    expect(d.left).toMatchObject({ mode: "app", autoflash: true, build: "old1234", protocol: 2, repo: "octocat/adv360" });
    expect(d.right).toMatchObject({ mode: "app", autoflash: true, build: "old1234" });
    expect(d.needsAccess).toBe(false);
  });

  it("updates both halves over their update ports without a single click", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    kb.allowUpdatePorts();
    const { engine, events } = await setup(kb);
    const end = await run(engine, events, kb);

    const build = github.head("octocat", "adv360").slice(0, 7);
    expect(end).toEqual({ type: "done", build, checked: true });
    expect([kb.left.build, kb.right.build]).toEqual([build, build]);
    expect(kb.right.flashedWith).toBe(`right-clique:${build}`);
    expect(kb.left.flashedWith).toBe(`left-clique:${build}`);
    expect(events.some((e) => ["update-port", "drive", "manual", "grant-port"].includes(e.type))).toBe(false);
    expect(kb.pickerOpened).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "step", step: "flash-right", detail: "Sending firmware 100%" }));
    const order = events.filter((e) => e.type === "step" && e.state === "done" && e.step.startsWith("flash-")).map((e) => e.type === "step" && e.step);
    expect(order).toEqual(["flash-right", "flash-left"]);
  });

  it("asks once for each half's update port, then never again", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    const { engine, events } = await setup(kb);
    expect(await run(engine, events, kb)).toMatchObject({ type: "done", checked: true });
    expect(sides(events, "update-port")).toEqual(["right", "left"]);

    events.length = 0;
    expect(await run(engine, events, kb)).toMatchObject({ type: "done", checked: true });
    expect(sides(events, "update-port")).toEqual([]);
  });

  it("sets up halves without Tandem firmware: key combo, update port, then the new port", async () => {
    // Kinesis's firmware: the right half has no port, the left only ZMK Studio's.
    const kb = new FakeKeyboard({ left: { build: null, studio: true }, right: { build: null } });
    kb.allowAll();
    const { engine, access, events } = await setup(kb);
    await until(() => access.devices().left.mode === "app");
    expect(access.devices().left).toMatchObject({ autoflash: false, otherPorts: ["web-serial"] });
    expect(access.devices().right.mode).toBe("missing");

    expect(await run(engine, events, kb, {}, false)).toMatchObject({ type: "done", checked: true });
    expect(sides(events, "manual")).toEqual(["right", "left"]);
    expect(sides(events, "update-port")).toEqual(["right", "left"]);
    expect(sides(events, "grant-port")).toEqual(["right", "left"]);
    // The new ports come last, after both halves have their firmware.
    const lastFlash = events.findLastIndex((e) => e.type === "update-port-done");
    expect(events.findIndex((e) => e.type === "grant-port")).toBeGreaterThan(lastFlash);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "grant-port", retry: true }));
    expect(kb.pickerOpened).toBe(0);
    expect(access.devices().left.autoflash && access.devices().right.autoflash).toBe(true);
  });

  it("takes the other half's new port when that's the one picked", async () => {
    const kb = new FakeKeyboard({ left: { build: null, studio: true }, right: { build: null } });
    kb.allowAll();
    const { engine, access, events } = await setup(kb);
    await until(() => access.devices().left.mode === "app");
    // Asked for the right half's port, the user picks the left half's first.
    expect(await run(engine, events, kb, { anyPort: true }, false)).toMatchObject({ type: "done", checked: true });
    expect(events.filter((e) => e.type === "grant-port")).toEqual([
      { type: "grant-port", side: "right", retry: false },
      { type: "grant-port", side: "right", retry: false },
    ]);
  });

  it("asks again when the user picks the wrong port in Chrome's list", async () => {
    const kb = new FakeKeyboard({ left: { build: null, studio: true }, right: { build: null } });
    kb.allowAll();
    kb.allowUpdatePorts();
    const { engine, access, events } = await setup(kb);
    await until(() => access.devices().left.mode === "app");
    kb.wrongPicks = 1;
    expect(await run(engine, events, kb, {}, false)).toMatchObject({ type: "done", checked: true });
    expect(events).toContainEqual({ type: "grant-port", side: "right", retry: true });
    expect(access.devices().left.autoflash && access.devices().right.autoflash).toBe(true);
  });

  it("updates the other half first when the key combo lands on it", async () => {
    const kb = new FakeKeyboard({ left: { build: null, studio: true }, right: { build: null } });
    kb.allowAll();
    kb.allowUpdatePorts();
    const { engine, access, events } = await setup(kb);
    await until(() => access.devices().left.mode === "app");
    const end = await run(engine, events, kb, { wrongHalf: [0] }, false);
    const build = github.head("octocat", "adv360").slice(0, 7);
    expect(end).toEqual({ type: "done", build, checked: true });
    expect(events).toContainEqual({ type: "switched", from: "right", to: "left" });
    expect(kb.left.flashedWith).toBe(`left-clique:${build}`);
    expect(kb.right.flashedWith).toBe(`right-clique:${build}`);
    expect(sides(events, "manual")).toEqual(["right", "right"]);
  });

  it("updates a finished half again when the key combo lands on it, then asks for the other", async () => {
    const kb = new FakeKeyboard({ left: { build: null, studio: true }, right: { build: null } });
    kb.allowAll();
    kb.allowUpdatePorts();
    const { engine, access, events } = await setup(kb);
    await until(() => access.devices().left.mode === "app");
    // Right goes as asked. Then the combo meant for the left lands on the right.
    expect(await run(engine, events, kb, { wrongHalf: [1] }, false)).toMatchObject({ type: "done", checked: true });
    expect(events).toContainEqual({ type: "switched", from: "left", to: "right" });
    expect(sides(events, "manual")).toEqual(["right", "left", "left"]);
  });

  it("copies to the drive instead when the user prefers", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    const { engine, events } = await setup(kb);
    expect(await run(engine, events, kb, { preferDrive: true })).toMatchObject({ type: "done", checked: true });
    expect(kb.right.flashedWith).toMatch(/^right-clique:/);
    expect(kb.left.flashedWith).toMatch(/^left-clique:/);
    expect(kb.pickerOpened).toBeGreaterThan(0);
  });

  it("asks for the drive again when the browser won't write through the saved one", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    kb.remount = "read-only";
    const { engine, events } = await setup(kb, undefined, new FakeDrive(kb, 0));
    expect(await run(engine, events, kb, { preferDrive: true })).toMatchObject({ type: "done", checked: true });
    expect(kb.refusedWrites).toBe(1);
    expect(sides(events, "drive")).toEqual(["right"]);

    // Next time Tandem doesn't try the saved drive at all.
    events.length = 0;
    expect(await run(engine, events, kb, { preferDrive: true })).toMatchObject({ type: "done", checked: true });
    expect(kb.refusedWrites).toBe(1);
  });

  it("falls back to the drive when the update port stops answering", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    kb.allowUpdatePorts();
    kb.right.bootPort.silent = true;
    const { engine, events } = await setup(kb);
    expect(await run(engine, events, kb)).toMatchObject({ type: "done", checked: true });
    expect(sides(events, "drive")).toEqual(["right"]);
    expect(events).toContainEqual(expect.objectContaining({ step: "flash-right", detail: expect.stringMatching(/Sending over the update port failed/) }));
  });

  it("turns down a folder that isn't an update drive and keeps waiting", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    let picks = 0;
    const { engine, events } = await setup(kb, () => (picks++ === 0 ? notADrive : new FakeDrive(kb, kb.mountCount)));
    const { keymap } = await engine.state();
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    await engine.update(keymap);
    await until(() => events.find((e) => e.type === "update-port"));
    await expect(engine.act({ type: "pick-drive", side: "right" })).rejects.toThrow(/isn't a keyboard half's update drive/);
    await engine.act({ type: "pick-drive", side: "right" });
    const stop = autopilot(engine, events, kb);
    expect(await until(() => events.find((e) => e.type === "done" || e.type === "error"))).toMatchObject({ type: "done", checked: true });
    stop();
  });

  it("stops when a half comes back on the wrong build", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    kb.allowUpdatePorts();
    kb.right.rejectsFirmware = true;
    const { engine, events } = await setup(kb);
    const end = await run(engine, events, kb);
    expect(end).toMatchObject({ type: "error", message: expect.stringMatching(/right half is running build old1234/) });
    expect(kb.left.flashedWith).toBeNull();
  });

  it("asks a port again when it didn't answer at first", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.right.silentUntil = Date.now() + 400;
    kb.allowAll();
    kb.allowUpdatePorts();
    const { engine, access, events } = await setup(kb);
    await until(() => access.devices().left.autoflash);
    expect(access.devices().right.autoflash).toBe(false);

    await new Promise((r) => setTimeout(r, 400));
    expect(await run(engine, events, kb)).toMatchObject({ type: "done", checked: true });
    expect(events.some((e) => e.type === "manual" || e.type === "grant-port")).toBe(false);
  });

  it("asks for a half's port before a key combo when the other half runs Tandem", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowed.add(kb.left.tandemPort!);
    kb.allowUpdatePorts();
    const { engine, events } = await setup(kb);
    expect(await run(engine, events, kb)).toMatchObject({ type: "done", checked: true });
    expect(events).toContainEqual({ type: "grant-port", side: "right", before: true });
    expect(events.some((e) => e.type === "manual")).toBe(false);
    expect(events).toContainEqual({ type: "step", step: "flash-right", state: "active", detail: "Restarting into update mode" });
  });

  it("falls back to the key combo when there's no port to allow", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: null } });
    kb.allowAll();
    kb.allowUpdatePorts();
    const { engine, events } = await setup(kb);
    expect(await run(engine, events, kb, { skipPortFirst: true }, false)).toMatchObject({ type: "done", checked: true });
    expect(sides(events, "manual")).toEqual(["right"]);
  });

  it("finishes a half that a reload left in update mode", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    kb.allowUpdatePorts();
    const { engine, events } = await setup(kb);
    kb.right.enterUpdateMode();
    await until(() => kb.right.mode === "update");
    expect(await run(engine, events, kb, {}, false)).toMatchObject({ type: "done", checked: true });
    expect(events).toContainEqual({ type: "step", step: "flash-right", state: "active", detail: "Already in update mode" });
    expect(events.some((e) => ["update-port", "drive", "manual"].includes(e.type))).toBe(false);
  });

  it("won't guess which half is in update mode", async () => {
    const kb = new FakeKeyboard({ left: { build: null, studio: true }, right: { build: null } });
    kb.allowAll();
    kb.allowUpdatePorts();
    const { engine, events } = await setup(kb);
    kb.right.enterUpdateMode();
    const end = await run(engine, events, kb, {}, false);
    expect(end).toMatchObject({ type: "error", message: expect.stringMatching(/can't tell which/) });
    expect(kb.right.flashedWith).toBeNull();
  });

  it("reads the layout from Tandem firmware", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.left.keymap = read("template/config/adv360.keymap");
    kb.allowAll();
    const { engine } = await setup(kb);
    const info = await engine.keyboard();
    expect(info).toMatchObject({ tandemKeymap: true, tandemRepo: "octocat/adv360" });
    const layout = await engine.readKeyboard();
    expect(layout.source).toBe("tandem");
    expect(layout.layers.map((l) => l.name)).toEqual(["Base", "Kp", "Fn", "Mod"]);
  });

  it("asks for ports it hasn't been allowed yet", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    const { engine, access } = await setup(kb);
    expect(access.devices().needsAccess).toBe(true);
    await engine.connectKeyboard();
    await engine.connectKeyboard();
    await until(() => access.devices().left.autoflash && access.devices().right.autoflash);
    expect(access.devices().needsAccess).toBe(false);
    // Nothing left to allow: the picker closes without a port, which isn't an error.
    await engine.connectKeyboard();
  });
});
