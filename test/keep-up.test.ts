// Keeping a repo up to date and getting back from an update: Kinesis's changes,
// Tandem's own, undoing them, older builds and leaving Tandem. The browser
// engine against an in-memory GitHub, in a browser without Web Serial.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseKeymap, importKeymap } from "../shared/keymap";
import { readLayout } from "../shared/layout";
import pins from "../shared/pins.json";
import { HOLD_PATH, patchManifest, patchWorkflow, unpatchManifest, unpatchWorkflow } from "../shared/setup";
import { KINESIS_BASE_PATH } from "../shared/sync";
import type { JobEvent } from "../shared/types";
import { MODULE_FILES } from "../src/engine/module";
import type { Engine } from "../src/engine/types";
import { FakeGitHub } from "./fakes/github";

const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

const DEFCONFIG = "config/boards/arm/adv360/adv360_left_defconfig";
const WORKFLOW = ".github/workflows/build.yml";
const MANIFEST = "config/west.yml";
const KEYMAP = "config/adv360.keymap";
const info = read("template/config/info.json");

const defconfig = (...edits: string[]) => ["CONFIG_A=y", "CONFIG_B=y", "CONFIG_C=y", "CONFIG_D=y", "CONFIG_E=y", ...edits].join("\n") + "\n";

/** Kinesis's repo, one commit before the commit Tandem tested. */
function kinesisFiles(): Record<string, string> {
  return {
    [WORKFLOW]: unpatchWorkflow(read("template/.github/workflows/build.yml")),
    [MANIFEST]: unpatchManifest(read("template/config/west.yml")),
    [KEYMAP]: read("test/fixtures/adv360.keymap"),
    "config/info.json": info,
    [DEFCONFIG]: defconfig(),
    "bin/get_version.sh": "#!/bin/sh\necho 1\n",
    "README.md": "Kinesis's readme\n",
  };
}

let fake: FakeGitHub;
let restore: () => void;
let base: string;

beforeEach(() => {
  fake = new FakeGitHub();
  restore = fake.install();
  base = fake.addRepo("KinesisCorporation", "Adv360-Pro-ZMK", kinesisFiles(), { branch: "V3.0" });
});

afterEach(() => {
  restore();
  vi.useRealTimers();
});

/** Kinesis's next commit, the one Tandem tested. */
const kinesisChanges = (files: Record<string, string | Uint8Array | null>, message = "Tweak the config") =>
  fake.push("KinesisCorporation", "Adv360-Pro-ZMK", "V3.0", files, message, pins.kinesis.sha);

/** A user's repo made from the template, at Kinesis's older commit. */
function templateRepo(edit: (files: Record<string, string>) => void = () => {}) {
  const k = kinesisFiles();
  const { rows } = readLayout(info);
  const files: Record<string, string> = {
    ...k,
    [WORKFLOW]: patchWorkflow(k[WORKFLOW])!,
    [MANIFEST]: patchManifest(k[MANIFEST]),
    [KEYMAP]: importKeymap(k[KEYMAP], rows).text,
    "README.md": "The template's readme\n",
    [KINESIS_BASE_PATH]: `${base}\n`,
  };
  for (const f of MODULE_FILES) files[f.path] = f.content;
  edit(files);
  fake.build(fake.addRepo("octocat", "adv360", files));
}

async function engine(): Promise<Engine> {
  vi.resetModules();
  const store = await import("../src/engine/store");
  store.saveToken({ token: "gho_test", scope: "public_repo workflow" });
  const { browserEngine } = await import("../src/engine/browser");
  const e = browserEngine();
  await e.connect({ owner: "octocat", name: "adv360", branch: "main" });
  return e;
}

function record(e: Engine): JobEvent[] {
  const events: JobEvent[] = [];
  e.subscribe((l) => l.type === "job-event" && events.push(l.event));
  return events;
}

async function until<T>(check: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Runs an update to the end, copying firmware by hand. */
async function update(e: Engine, events: JobEvent[]) {
  events.length = 0;
  await e.update();
  await until(() => events.find((x) => x.type === "manual-flash" || x.type === "error"));
  if (events.some((x) => x.type === "error")) return;
  await e.act({ type: "manual-flash-done" });
  await until(() => events.find((x) => x.type === "done"));
}

const head = () => fake.head("octocat", "adv360");
const at = (path: string) => fake.fileAt(head(), path);
const message = () => fake.commits.get(head())!.message;

describe("Kinesis's changes", () => {
  it("leaves a repo alone that has the tested commit", async () => {
    kinesisChanges({ [DEFCONFIG]: defconfig("CONFIG_NEW=y") });
    templateRepo((f) => (f[KINESIS_BASE_PATH] = `${pins.kinesis.sha}\n`));
    const e = await engine();
    expect((await e.session()).kinesis).toBeNull();
    const before = head();
    await update(e, record(e));
    expect(head()).toBe(before);
  });

  it("ignores Kinesis commits Tandem hasn't tested", async () => {
    kinesisChanges({ [DEFCONFIG]: defconfig("CONFIG_NEW=y") });
    fake.push("KinesisCorporation", "Adv360-Pro-ZMK", "V3.0", { [DEFCONFIG]: "broken\n" }, "Not tested yet");
    templateRepo();
    const e = await engine();
    await update(e, record(e));
    expect(at(DEFCONFIG)).toBe(defconfig("CONFIG_NEW=y"));
  });

  it("brings them in with a keyboard update, once", async () => {
    kinesisChanges({ [DEFCONFIG]: defconfig("CONFIG_NEW=y") }, "Turn on the new thing");
    templateRepo();
    const e = await engine();
    expect((await e.session()).kinesis).toMatchObject({ commits: ["Turn on the new thing"], conflicts: [], kept: [], held: false });

    const events = record(e);
    await update(e, events);
    expect(at(DEFCONFIG)).toBe(defconfig("CONFIG_NEW=y"));
    expect(at(KINESIS_BASE_PATH)).toBe(`${pins.kinesis.sha}\n`);
    expect(message()).toMatch(/^Sync with Kinesis 97f5d73\n[^]*- Turn on the new thing/);
    expect(events).toContainEqual({ type: "step", step: "save", state: "done", detail: `Committed Kinesis's changes, ${head().slice(0, 7)}` });
    expect((await e.session()).kinesis).toBeNull();

    const after = head();
    await update(e, events);
    expect(head()).toBe(after);
  });

  it("merges a file both changed in different places", async () => {
    kinesisChanges({ [DEFCONFIG]: defconfig("CONFIG_NEW=y") });
    templateRepo((f) => (f[DEFCONFIG] = defconfig().replace("CONFIG_A=y", "CONFIG_A=n")));
    const e = await engine();
    await update(e, record(e));
    expect(at(DEFCONFIG)).toBe(defconfig("CONFIG_NEW=y").replace("CONFIG_A=y", "CONFIG_A=n"));
  });

  it("keeps Tandem's edits to the workflow and the manifest", async () => {
    const workflow = kinesisFiles()[WORKFLOW].replace("name: Build\n", "name: Build the firmware\n");
    const manifest = kinesisFiles()[MANIFEST].replace("self:\n", "self:\n    # Kinesis's note\n");
    kinesisChanges({ [WORKFLOW]: workflow, [MANIFEST]: manifest });
    templateRepo();
    const e = await engine();
    await update(e, record(e));
    expect(at(WORKFLOW)).toBe(patchWorkflow(workflow));
    expect(at(MANIFEST)).toBe(patchManifest(manifest));
    expect((await e.session()).setup).toMatchObject({ installed: true, outdated: false });
  });

  it("replaces a default layout but keeps a changed one", async () => {
    const newDefault = kinesisFiles()[KEYMAP].replace("&kp Q", "&kp W");
    kinesisChanges({ [KEYMAP]: newDefault });

    templateRepo();
    let e = await engine();
    await update(e, record(e));
    expect(at(KEYMAP)).toBe(importKeymap(newDefault, readLayout(info).rows).text);

    fake.repos.delete("octocat/adv360");
    templateRepo((f) => (f[KEYMAP] = f[KEYMAP].replace("&kp A", "&kp B")));
    e = await engine();
    const mine = at(KEYMAP);
    expect((await e.session()).kinesis).toMatchObject({ kept: [KEYMAP], conflicts: [] });
    const events = record(e);
    await update(e, events);
    expect(at(KEYMAP)).toBe(mine);
    expect(at(KINESIS_BASE_PATH)).toBe(`${pins.kinesis.sha}\n`);
    expect(events).toContainEqual({ type: "note", text: `Kinesis changed these files too, and Tandem kept yours: ${KEYMAP}.` });
  });

  it("stops at a clash, and the keyboard still updates", async () => {
    kinesisChanges({ [DEFCONFIG]: defconfig().replace("CONFIG_C=y", "CONFIG_C=m") });
    templateRepo((f) => (f[DEFCONFIG] = defconfig().replace("CONFIG_C=y", "CONFIG_C=n")));
    const e = await engine();
    expect((await e.session()).kinesis).toMatchObject({ conflicts: [DEFCONFIG] });
    const before = head();
    const events = record(e);
    await update(e, events);
    expect(head()).toBe(before);
    expect(events).toContainEqual(expect.objectContaining({ type: "done" }));
  });

  it("doesn't let a clash in the readme stop it", async () => {
    kinesisChanges({ "README.md": "Kinesis's new readme\n", [DEFCONFIG]: defconfig("CONFIG_NEW=y") });
    templateRepo();
    const e = await engine();
    expect((await e.session()).kinesis).toMatchObject({ conflicts: [], kept: ["README.md"] });
    await update(e, record(e));
    expect(at("README.md")).toBe("The template's readme\n");
    expect(at(DEFCONFIG)).toBe(defconfig("CONFIG_NEW=y"));
  });

  it("keeps a binary file both changed, rather than mangling it", async () => {
    const ours = new Uint8Array([1, 0, 2, 0xff]);
    kinesisChanges({ "settings-reset.uf2": new Uint8Array([9, 0, 9, 0xfe]), [DEFCONFIG]: defconfig("CONFIG_NEW=y") });
    fake.push("KinesisCorporation", "Adv360-Pro-ZMK", "V3.0", {}, "nothing");
    templateRepo();
    fake.push("octocat", "adv360", "main", { "settings-reset.uf2": ours });
    const e = await engine();
    expect((await e.session()).kinesis).toMatchObject({ conflicts: [] });
    await update(e, record(e));
    expect(fake.commits.get(head())!.tree.get("settings-reset.uf2")).toEqual(ours);
    expect(at(DEFCONFIG)).toBe(defconfig("CONFIG_NEW=y"));
  });

  it("adds and removes files, and copies binary ones and file modes", async () => {
    const uf2 = new Uint8Array([0x55, 0x46, 0x32, 0x00, 0xff, 0x80]);
    fake.modes.set("bin/get_version.sh", "100755");
    kinesisChanges({ "settings-reset.uf2": uf2, "bin/get_version.sh": "#!/bin/sh\necho 2\n", "README.md": null });
    templateRepo((f) => (f["README.md"] = "Kinesis's readme\n"));
    const e = await engine();
    await update(e, record(e));
    expect(fake.commits.get(head())!.tree.get("settings-reset.uf2")).toEqual(uf2);
    expect(at("bin/get_version.sh")).toBe("#!/bin/sh\necho 2\n");
    expect(fake.modes.get("bin/get_version.sh")).toBe("100755");
    expect(at("README.md")).toBeNull();
  });

  it("doesn't bring back a file the repo removed", async () => {
    kinesisChanges({ "bin/get_version.sh": "#!/bin/sh\necho 2\n" });
    templateRepo((f) => delete f["bin/get_version.sh"]);
    const e = await engine();
    await update(e, record(e));
    expect(at("bin/get_version.sh")).toBeNull();
  });

  it("updates with Tandem's own changes on top", async () => {
    kinesisChanges({ [WORKFLOW]: kinesisFiles()[WORKFLOW].replace("name: Build\n", "name: Build the firmware\n") });
    templateRepo((f) => (f["tandem/zmk-tandem/src/reconnect.c"] = "// an older version\n"));
    const e = await engine();
    const events = record(e);
    await update(e, events);
    const commit = fake.commits.get(head())!;
    expect(commit.message).toMatch(/^Update Tandem to release \d+/);
    expect(fake.commits.get(commit.parents[0])!.message).toMatch(/^Sync with Kinesis/);
    expect(events).toContainEqual({ type: "step", step: "save", state: "done", detail: `Committed Kinesis's changes and Tandem's update, ${head().slice(0, 7)}` });
  });

  describe("on a fork", () => {
    function forkRepo(edit: Record<string, string> = {}) {
      fake.fork("octocat", "adv360", "KinesisCorporation/Adv360-Pro-ZMK", base);
      const k = kinesisFiles();
      const { rows } = readLayout(info);
      const setup: Record<string, string> = {
        [WORKFLOW]: patchWorkflow(k[WORKFLOW])!,
        [MANIFEST]: patchManifest(k[MANIFEST]),
        [KEYMAP]: importKeymap(k[KEYMAP], rows).text,
        ...edit,
      };
      for (const f of MODULE_FILES) setup[f.path] = f.content;
      fake.push("octocat", "adv360", "main", setup, "Add Tandem automatic updates");
    }

    it("makes a merge commit, so GitHub stops counting it as behind", async () => {
      kinesisChanges({ [DEFCONFIG]: defconfig("CONFIG_NEW=y") });
      forkRepo();
      const e = await engine();
      expect((await e.session()).kinesis).toMatchObject({ commits: ["Tweak the config"] });
      await update(e, record(e));
      expect(fake.commits.get(head())!.parents).toEqual([expect.any(String), pins.kinesis.sha]);
      expect(at(DEFCONFIG)).toBe(defconfig("CONFIG_NEW=y"));
      expect((await e.session()).kinesis).toBeNull();
    });

    it("falls back to a plain commit when GitHub refuses the merge", async () => {
      kinesisChanges({ [DEFCONFIG]: defconfig("CONFIG_NEW=y") });
      forkRepo();
      fake.refuseMerges = true;
      const e = await engine();
      await update(e, record(e));
      expect(fake.commits.get(head())!.parents).toHaveLength(1);
      expect(at(KINESIS_BASE_PATH)).toBe(`${pins.kinesis.sha}\n`);
      expect((await e.session()).kinesis).toBeNull();
    });

    it("brings undone changes back when the pin next moves", async () => {
      kinesisChanges({ [DEFCONFIG]: defconfig("CONFIG_NEW=y") });
      forkRepo();
      const e = await engine();
      const events = record(e);
      await update(e, events);
      const undone = await e.undoUpdate(head());
      expect(at(DEFCONFIG)).toBe(defconfig());
      expect(at(KINESIS_BASE_PATH)).toBe(`${base}\n`);
      expect(undone.kinesis).toMatchObject({ held: true });

      // Updates leave it out for now.
      const before = head();
      await update(e, events);
      expect(head()).toBe(before);

      // A newer release tested a newer Kinesis commit.
      const next = fake.push("KinesisCorporation", "Adv360-Pro-ZMK", "V3.0", { "config/other.conf": "OTHER=y\n" }, "Later");
      const { default: loaded } = await import("../shared/pins.json");
      const tested = loaded.kinesis.sha;
      loaded.kinesis.sha = next;
      try {
        await update(e, events);
        expect(at(DEFCONFIG)).toBe(defconfig("CONFIG_NEW=y"));
        expect(at("config/other.conf")).toBe("OTHER=y\n");
      } finally {
        loaded.kinesis.sha = tested;
      }
    });

    it("has nothing to do when the fork was synced by hand", async () => {
      kinesisChanges({ [DEFCONFIG]: defconfig("CONFIG_NEW=y") });
      fake.fork("octocat", "adv360", "KinesisCorporation/Adv360-Pro-ZMK");
      const e = await engine();
      expect((await e.session()).kinesis).toBeNull();
    });
  });
});

describe("undoing Tandem's commits", () => {
  const OLD = "// an older version\n";
  const older = (f: Record<string, string>) => {
    f["tandem/zmk-tandem/src/reconnect.c"] = OLD;
    f["tandem/zmk-tandem/version.txt"] = "3\n";
  };

  it("offers it when the build of Tandem's commit fails, then leaves that release out", async () => {
    templateRepo((f) => {
      older(f);
      f[KINESIS_BASE_PATH] = `${pins.kinesis.sha}\n`;
    });
    fake.push("KinesisCorporation", "Adv360-Pro-ZMK", "V3.0", {}, "Same", pins.kinesis.sha);
    const e = await engine();
    expect((await e.session()).setup).toMatchObject({ outdated: true, version: 3, held: false });

    fake.failBuilds = true;
    const events = record(e);
    await update(e, events);
    const failed = head();
    expect(fake.commits.get(failed)!.message).toMatch(/^Update Tandem to release 4/);
    expect(events).toContainEqual({ type: "undoable", commit: expect.objectContaining({ sha: failed, title: "Update Tandem to release 4" }) });
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringMatching(/build failed/) }));

    fake.failBuilds = false;
    const s = await e.undoUpdate(failed);
    expect(at("tandem/zmk-tandem/src/reconnect.c")).toBe(OLD);
    expect(at("tandem/zmk-tandem/version.txt")).toBe("3\n");
    expect(JSON.parse(at(HOLD_PATH)!)).toEqual({ tandem: 4 });
    expect(message()).toBe(`Undo "Update Tandem to release 4"\n\nUndoes ${failed}.`);
    expect(s.setup).toMatchObject({ outdated: true, held: true });

    // Updates now leave it out, and the keyboard still updates.
    const undone = head();
    await update(e, events);
    expect(head()).toBe(undone);
    expect(events).toContainEqual(expect.objectContaining({ type: "done" }));
    expect((await e.history()).updates).toEqual([]);

    // Installing it by hand still works.
    await e.install();
    expect(at("tandem/zmk-tandem/src/reconnect.c")).not.toBe(OLD);
  });

  it("doesn't blame Tandem's commit for a layout that went in with it", async () => {
    templateRepo((f) => {
      older(f);
      f[KINESIS_BASE_PATH] = `${pins.kinesis.sha}\n`;
    });
    const e = await engine();
    fake.failBuilds = true;
    const events = record(e);
    const { keymap } = await e.state();
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    await e.update(keymap);
    await until(() => events.find((x) => x.type === "error"));
    expect(message()).toMatch(/^Update Tandem to release 4/);
    expect(events.some((x) => x.type === "undoable")).toBe(false);
  });

  it("doesn't blame Tandem's commit for a layout that won't build", async () => {
    templateRepo((f) => {
      older(f);
      f[KINESIS_BASE_PATH] = `${pins.kinesis.sha}\n`;
    });
    const e = await engine();
    await e.install();
    fake.failBuilds = true;
    const events = record(e);
    const { keymap } = await e.state();
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    await e.update(keymap);
    await until(() => events.find((x) => x.type === "error"));
    expect(events.some((x) => x.type === "undoable")).toBe(false);
  });

  it("keeps layout saves made after the commit", async () => {
    templateRepo((f) => {
      older(f);
      f[KINESIS_BASE_PATH] = `${pins.kinesis.sha}\n`;
    });
    const e = await engine();
    await e.install();
    const update = head();
    const { keymap } = await e.state();
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    await e.saveKeymap(keymap);

    await e.undoUpdate(update);
    expect(parseKeymap(at(KEYMAP)!).layers[0].bindings[15]).toBe("&ltr 2 Q");
    expect(at("tandem/zmk-tandem/src/reconnect.c")).toBe(OLD);
  });

  it("refuses when a file changed after the commit", async () => {
    templateRepo((f) => {
      older(f);
      f[KINESIS_BASE_PATH] = `${pins.kinesis.sha}\n`;
    });
    const e = await engine();
    await e.install();
    const update = head();
    fake.push("octocat", "adv360", "main", { "tandem/zmk-tandem/src/reconnect.c": "// my own edit\n" });
    await expect(e.undoUpdate(update)).rejects.toThrow(/reconnect\.c/);
  });

  it("only undoes Tandem's own commits", async () => {
    templateRepo();
    const e = await engine();
    await expect(e.undoUpdate(head())).rejects.toThrow(/only undoes/);
  });

  it("undoes a sync and leaves it out until Kinesis moves on", async () => {
    kinesisChanges({ [DEFCONFIG]: defconfig("CONFIG_NEW=y") });
    templateRepo();
    const e = await engine();
    const events = record(e);
    await update(e, events);
    const synced = head();
    expect((await e.history()).updates).toEqual([expect.objectContaining({ sha: synced })]);

    const s = await e.undoUpdate(synced);
    expect(at(DEFCONFIG)).toBe(defconfig());
    expect(at(KINESIS_BASE_PATH)).toBe(`${base}\n`);
    expect(JSON.parse(at(HOLD_PATH)!)).toEqual({ kinesis: pins.kinesis.sha });
    expect(s.kinesis).toMatchObject({ held: true });

    const undone = head();
    await update(e, events);
    expect(head()).toBe(undone);
  });
});

describe("going back", () => {
  it("puts a kept build back without touching the repo", async () => {
    templateRepo((f) => (f[KINESIS_BASE_PATH] = `${pins.kinesis.sha}\n`));
    const e = await engine();
    const events = record(e);
    await update(e, events);
    const first = head().slice(0, 7);
    const { keymap } = await e.state();
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    events.length = 0;
    await e.update(keymap);
    await until(() => events.find((x) => x.type === "manual-flash"));
    await e.act({ type: "manual-flash-done" });
    await until(() => events.find((x) => x.type === "done"));

    const { builds } = await e.history();
    expect(builds.map((b) => b.id)).toContain(first);
    const kept = builds.find((b) => b.id === first)!;
    expect(kept.studio).toBe(true);

    const before = head();
    const commits = fake.commits.size;
    events.length = 0;
    await e.flashBuild(kept.key);
    await until(() => events.find((x) => x.type === "manual-flash"));
    await e.act({ type: "manual-flash-done" });
    expect(await until(() => events.find((x) => x.type === "done"))).toEqual({ type: "done", build: first, checked: false });
    expect(events[0]).toEqual({ type: "rollback", build: first });
    expect(head()).toBe(before);
    expect(fake.commits.size).toBe(commits);
  });

  it("flashes a kept build of Kinesis's firmware without asking the halves", async () => {
    templateRepo((f) => (f[KINESIS_BASE_PATH] = `${pins.kinesis.sha}\n`));
    const e = await engine();
    const events = record(e);
    await e.leaveTandem();
    await until(() => events.find((x) => x.type === "manual-flash"));
    await e.act({ type: "manual-flash-done" });
    await until(() => events.find((x) => x.type === "done"));
    const kept = (await e.history()).builds[0];
    expect(kept.stock).toBe(true);
  });

  it("can try leaving again after a build fails", async () => {
    templateRepo((f) => (f[KINESIS_BASE_PATH] = `${pins.kinesis.sha}\n`));
    const e = await engine();
    fake.failBuilds = true;
    const events = record(e);
    await e.leaveTandem();
    await until(() => events.find((x) => x.type === "error"));
    const removed = head();

    fake.failBuilds = false;
    fake.build(removed);
    fake.runs.splice(0, fake.runs.length, ...fake.runs.filter((r) => !r.failed));
    events.length = 0;
    await e.leaveTandem();
    await until(() => events.find((x) => x.type === "manual-flash"));
    expect(head()).toBe(removed);
    await e.act({ type: "manual-flash-done" });
    await until(() => events.find((x) => x.type === "done"));
  });

  it("says when a build is gone", async () => {
    templateRepo();
    const e = await engine();
    const events = record(e);
    await e.flashBuild("nope");
    expect(await until(() => events.find((x) => x.type === "error"))).toMatchObject({ message: expect.stringMatching(/no longer has/) });
  });

  it("leaves Tandem: Kinesis's build files back, the module gone, the layout kept", async () => {
    templateRepo((f) => {
      f[KINESIS_BASE_PATH] = `${pins.kinesis.sha}\n`;
      f[HOLD_PATH] = "{}\n";
      f[KEYMAP] = f[KEYMAP].replace("&kp A", "&kp B");
    });
    const e = await engine();
    const mine = at(KEYMAP);
    const events = record(e);
    await e.leaveTandem();
    await until(() => events.find((x) => x.type === "manual-flash"));
    await e.act({ type: "manual-flash-done" });
    await until(() => events.find((x) => x.type === "done"));

    expect(events[0]).toEqual({ type: "leaving" });
    expect(message()).toMatch(/^Remove Tandem\n/);
    expect(at(WORKFLOW)).toBe(kinesisFiles()[WORKFLOW]);
    expect(at(MANIFEST)).toBe(kinesisFiles()[MANIFEST]);
    expect(at(KEYMAP)).toBe(mine);
    const tree = fake.commits.get(head())!.tree;
    expect([...tree.keys()].filter((p) => p.startsWith("tandem/"))).toEqual([]);
    expect((await e.session()).setup).toMatchObject({ installed: false, outdated: false });
  });
});

describe("the ZMK 4.1 trial", () => {
  const boards = "config/boards/arm/adv360/adv360.dtsi";

  /** The port's config repo: Kinesis's tested commit, plus its changes. */
  function port(workflow: string, manifest: string) {
    fake.fork("NorthIsUp", "Adv360-Pro-ZMK", "KinesisCorporation/Adv360-Pro-ZMK", pins.beta.base);
    return fake.push("NorthIsUp", "Adv360-Pro-ZMK", "main", { [WORKFLOW]: workflow, [MANIFEST]: manifest, [boards]: null, "config/adv360pro_left.conf": "CONFIG_X=y\n" }, "ZMK 4.1", pins.beta.sha);
  }

  const portWorkflow = () => kinesisFiles()[WORKFLOW].replaceAll("zmk-build-arm:stable", "zmk-build-arm:4.1").replaceAll("-b adv360_left", "-b adv360pro_left/nrf52840/zmk");
  const portManifest = () => kinesisFiles()[MANIFEST].replace("revision: adv360-z3.5-2", "revision: zmk-v0.3.0-191-g9ebbeff0-adv360.1");

  function setup(edit: (files: Record<string, string>) => void = () => {}) {
    kinesisChanges({ [boards]: "the board\n" });
    templateRepo((f) => {
      f[KINESIS_BASE_PATH] = `${pins.kinesis.sha}\n`;
      f[boards] = "the board\n";
      edit(f);
    });
    port(portWorkflow(), portManifest());
  }

  it("makes a branch with the port and leaves the old one alone", async () => {
    setup();
    const e = await engine();
    const before = head();

    const { session, kept } = await e.startBeta();
    expect(kept).toEqual([]);
    expect(session.repo).toMatchObject({ branch: "tandem-zmk-4.1" });
    expect(session.beta).toEqual({ from: "main" });
    expect(session.setup).toMatchObject({ installed: true, outdated: false });
    expect(head()).toBe(before);

    const beta = fake.head("octocat", "adv360", "tandem-zmk-4.1");
    expect(fake.commits.get(beta)!.message).toMatch(/^Try ZMK 4\.1\n/);
    expect(fake.fileAt(beta, WORKFLOW)).toBe(patchWorkflow(portWorkflow()));
    expect(fake.fileAt(beta, WORKFLOW)).toContain("-DZMK_EXTRA_MODULES=");
    expect(fake.fileAt(beta, WORKFLOW)).toContain("zmk-build-arm:4.1\n");
    expect(fake.fileAt(beta, MANIFEST)).toBe(portManifest());
    expect(fake.fileAt(beta, boards)).toBeNull();
    expect(fake.fileAt(beta, "config/adv360pro_left.conf")).toBe("CONFIG_X=y\n");

    // Updates work on it, and don't try to bring it back to Kinesis's.
    const events = record(e);
    await update(e, events);
    expect(fake.head("octocat", "adv360", "tandem-zmk-4.1")).toBe(beta);
    expect(events).toContainEqual(expect.objectContaining({ type: "done", build: beta.slice(0, 7) }));

    const back = await e.leaveBeta();
    expect(back.repo).toMatchObject({ branch: "main", head: before });
    expect(back.beta).toBeNull();
  });

  it("leaves no branch behind when committing the port fails", async () => {
    setup();
    fake.refuseCommits = true;
    const e = await engine();
    await expect(e.startBeta()).rejects.toThrow();
    expect(fake.repos.get("octocat/adv360")!.branches.has("tandem-zmk-4.1")).toBe(false);
    fake.refuseCommits = false;
    const { session } = await e.startBeta();
    expect(fake.fileAt(session.repo!.head, "config/adv360pro_left.conf")).toBe("CONFIG_X=y\n");
  });

  it("says which files it left alone", async () => {
    setup((f) => (f[boards] = "my own board\n"));
    const e = await engine();
    expect((await e.startBeta()).kept).toEqual([boards]);
    expect(fake.fileAt(fake.head("octocat", "adv360", "tandem-zmk-4.1"), boards)).toBe("my own board\n");
  });

  it("reuses the branch when there's one already", async () => {
    setup();
    const e = await engine();
    await e.startBeta();
    const made = fake.head("octocat", "adv360", "tandem-zmk-4.1");
    await e.leaveBeta();
    const { session } = await e.startBeta();
    expect(session.repo).toMatchObject({ branch: "tandem-zmk-4.1", head: made });
  });

  it("refuses when the port clashes with the repo's changes, and leaves no branch", async () => {
    setup((f) => (f[WORKFLOW] = f[WORKFLOW].replaceAll("-b adv360_left", "-b my_board")));
    const e = await engine();
    await expect(e.startBeta()).rejects.toThrow(/build\.yml/);
    expect(fake.repos.get("octocat/adv360")!.branches.has("tandem-zmk-4.1")).toBe(false);
    expect((await e.session()).repo).toMatchObject({ branch: "main" });
  });
});
