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

const TIMING = { savedDriveMs: 150, comebackMs: 600, newPortMs: 150, pollMs: 10, infoMs: 40 };

let github: FakeGitHub;
let restore: () => void;

beforeEach(() => {
  github = new FakeGitHub();
  restore = github.install();
  github.addRepo("octocat", "adv360", tandemRepo());
});

afterEach(() => restore());

async function setup(kb: FakeKeyboard, pick?: () => DriveLike) {
  vi.resetModules();
  const store = await import("../src/engine/store");
  store.saveToken({ token: "gho_test", scope: "public_repo workflow" });
  const { keyboardAccess } = await import("../src/engine/serial-keyboard");
  const { browserEngine } = await import("../src/engine/browser");
  const access = keyboardAccess({ serial: kb, pickDirectory: kb.picker(pick), timing: TIMING });
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

/** Plays the user: answers each request for a drive or a port as it comes. */
function autopilot(engine: Engine, events: JobEvent[], kb: FakeKeyboard) {
  let seen = 0;
  const timer = setInterval(() => {
    for (; seen < events.length; seen++) {
      const e = events[seen];
      if (e.type === "manual") kb[e.side].pressCombo();
      if (e.type === "drive") setTimeout(() => engine.act({ type: "pick-drive", side: e.side }).catch(() => {}), 30);
      if (e.type === "grant-port") engine.act({ type: "grant-port", side: e.side });
    }
  }, 5);
  return () => clearInterval(timer);
}

const done = (events: JobEvent[]) => () => events.find((e) => e.type === "done" || e.type === "error");

async function newLayout(engine: Engine) {
  const { keymap } = await engine.state();
  keymap.layers[0].bindings[15] = "&ltr 2 Q";
  return keymap;
}

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

  it("updates both halves, asking for the drive only once", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    const { engine, events } = await setup(kb);
    const stop = autopilot(engine, events, kb);
    await engine.update(await newLayout(engine));
    const end = await until(done(events));
    stop();

    const build = github.head("octocat", "adv360").slice(0, 7);
    expect(end).toEqual({ type: "done", build, checked: true });
    expect([kb.left.build, kb.right.build]).toEqual([build, build]);
    expect(kb.right.flashedWith).toMatch(/^UF2\nright-clique:/);
    expect(kb.left.flashedWith).toMatch(/^UF2\nleft-clique:/);
    // The left half reused the drive the user picked for the right.
    expect(events.filter((e) => e.type === "drive").map((e) => "side" in e && e.side)).toEqual(["right"]);
    expect(kb.pickerOpened).toBe(1);
    const order = events.filter((e) => e.type === "step" && e.state === "done" && e.step.startsWith("flash-")).map((e) => e.type === "step" && e.step);
    expect(order).toEqual(["flash-right", "flash-left"]);
  });

  it("asks for each drive when the browser forgets the last one", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    kb.handlesSurviveRemount = false;
    const { engine, events } = await setup(kb);
    const stop = autopilot(engine, events, kb);
    await engine.update(await newLayout(engine));
    expect(await until(done(events))).toMatchObject({ type: "done", checked: true });
    stop();
    expect(events.filter((e) => e.type === "drive").map((e) => "side" in e && e.side)).toEqual(["right", "left"]);
  });

  it("sets up halves without Tandem firmware: key combo, drive, then the new port", async () => {
    // Kinesis's firmware: the right half has no port, the left only ZMK Studio's.
    const kb = new FakeKeyboard({ left: { build: null, studio: true }, right: { build: null } });
    kb.allowAll();
    const { engine, access, events } = await setup(kb);
    await until(() => access.devices().left.mode === "app");
    expect(access.devices().left).toMatchObject({ autoflash: false, otherPorts: ["web-serial"] });
    expect(access.devices().right.mode).toBe("missing");

    const stop = autopilot(engine, events, kb);
    github.build(github.head("octocat", "adv360"));
    await engine.update();
    const end = await until(done(events), 6000);
    stop();

    expect(end).toMatchObject({ type: "done", checked: true });
    expect(events.filter((e) => e.type === "manual").map((e) => "side" in e && e.side)).toEqual(["right", "left"]);
    expect(events.filter((e) => e.type === "grant-port").map((e) => "side" in e && e.side)).toEqual(["right", "left"]);
    expect(access.devices().left.autoflash && access.devices().right.autoflash).toBe(true);
  });

  it("turns down a folder that isn't an update drive and keeps waiting", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    let picks = 0;
    const { engine, events } = await setup(kb, () => (picks++ === 0 ? notADrive : new FakeDrive(kb, kb.mountCount)));
    await engine.update(await newLayout(engine));
    await until(() => events.find((e) => e.type === "drive"));
    await expect(engine.act({ type: "pick-drive", side: "right" })).rejects.toThrow(/isn't a keyboard half's update drive/);
    await engine.act({ type: "pick-drive", side: "right" });
    const stop = autopilot(engine, events, kb);
    expect(await until(done(events))).toMatchObject({ type: "done", checked: true });
    stop();
  });

  it("stops when a half comes back on the wrong build", async () => {
    const kb = new FakeKeyboard({ left: { build: "old1234" }, right: { build: "old1234" } });
    kb.allowAll();
    kb.right.rejectsFirmware = true;
    const { engine, events } = await setup(kb);
    const stop = autopilot(engine, events, kb);
    await engine.update(await newLayout(engine));
    const end = await until(done(events));
    stop();
    expect(end).toMatchObject({ type: "error", message: expect.stringMatching(/right half is running build old1234/) });
    expect(kb.left.flashedWith).toBeNull();
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
