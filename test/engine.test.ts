// The browser engine against an in-memory GitHub, in a browser without Web
// Serial, so updates end with copying by hand.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseKeymap } from "../shared/keymap";
import type { JobEvent } from "../shared/types";
import { MODULE_FILES } from "../src/engine/module";
import type { Engine } from "../src/engine/types";
import { FakeGitHub } from "./fakes/github";

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

function kinesisRepo(): Record<string, string> {
  return {
    ".github/workflows/build.yml": read("test/fixtures/build.yml"),
    "config/adv360.keymap": read("test/fixtures/adv360.keymap"),
    "config/info.json": read("template/config/info.json"),
  };
}

let fake: FakeGitHub;
let restore: () => void;

beforeEach(() => {
  fake = new FakeGitHub();
  restore = fake.install();
});

afterEach(() => {
  restore();
  vi.useRealTimers();
});

/** A fresh engine, signed in with a stored token. */
async function engine(): Promise<Engine> {
  vi.resetModules();
  const store = await import("../src/engine/store");
  store.saveToken({ token: "gho_test", scope: "public_repo workflow" });
  const { browserEngine } = await import("../src/engine/browser");
  return browserEngine();
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

describe("browser engine", () => {
  it("signs in with a stored token and reads the connected repo", async () => {
    fake.addRepo("octocat", "adv360", tandemRepo());
    const e = await engine();

    const signedIn = await e.session();
    expect(signedIn).toMatchObject({ signedIn: true, login: "octocat", source: "oauth", missingScopes: [], privateRepos: false });

    const s = await e.connect({ owner: "octocat", name: "adv360", branch: "main" });
    expect(s.setup).toEqual({ installed: true, outdated: false, changes: [], blocker: null });

    const state = await e.state();
    expect(state.keymap.layers.map((l) => l.name)).toEqual(["Base", "Kp", "Fn", "Mod"]);
    expect(state.layout).toHaveLength(76);
    expect(state.buildId).toBe(fake.head("octocat", "adv360").slice(0, 7));
  });

  it("asks for the workflow scope when the token lacks it", async () => {
    fake.scopes = ["public_repo"];
    const s = await (await engine()).session();
    expect(s.missingScopes).toEqual(["workflow"]);
  });

  it("commits a layout change and leaves other layers' text alone", async () => {
    fake.addRepo("octocat", "adv360", tandemRepo());
    const e = await engine();
    await e.connect({ owner: "octocat", name: "adv360", branch: "main" });
    const before = fake.fileAt(fake.head("octocat", "adv360"), "config/adv360.keymap")!;

    const { keymap } = await e.state();
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    const after = await e.saveKeymap(keymap);

    const head = fake.head("octocat", "adv360");
    expect(after.buildId).toBe(head.slice(0, 7));
    expect(fake.commits.get(head)!.message).toBe("Update layout with Tandem");
    const text = fake.fileAt(head, "config/adv360.keymap")!;
    expect(parseKeymap(text).layers[0].bindings[15]).toBe("&ltr 2 Q");
    const layerText = (t: string, i: number) => {
      const { content } = parseKeymap(t).layers[i];
      return t.slice(content.start, content.end);
    };
    for (const i of [1, 2, 3]) expect(layerText(text, i)).toBe(layerText(before, i));
  });

  it("won't overwrite a branch that moved on GitHub", async () => {
    fake.addRepo("octocat", "adv360", tandemRepo());
    const e = await engine();
    await e.connect({ owner: "octocat", name: "adv360", branch: "main" });
    const { keymap } = await e.state();
    fake.push("octocat", "adv360", "main", { "README.md": "hello" });
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    await expect(e.saveKeymap(keymap)).rejects.toThrow(/changed on GitHub/);
  });

  it("commits nothing when the layout matches the branch", async () => {
    fake.addRepo("octocat", "adv360", tandemRepo());
    const e = await engine();
    await e.connect({ owner: "octocat", name: "adv360", branch: "main" });
    const head = fake.head("octocat", "adv360");
    const { keymap } = await e.state();
    // The same key under another name, as the picker spells it.
    const i = keymap.layers[0].bindings.indexOf("&kp BSPC");
    keymap.layers[0].bindings[i] = "&kp BACKSPACE";
    await e.saveKeymap(keymap);
    expect(fake.head("octocat", "adv360")).toBe(head);

    const events = record(e);
    await e.update(keymap);
    expect(await until(() => events.find((x) => x.type === "step" && x.step === "save" && x.state !== "active"))).toMatchObject({
      state: "skipped",
      detail: `No changes, using ${head.slice(0, 7)}`,
    });
    await e.cancel();
  });

  it("adds Tandem to a repo with Kinesis's config", async () => {
    fake.addRepo("octocat", "kinesis-fork", kinesisRepo());
    const e = await engine();
    const s = await e.connect({ owner: "octocat", name: "kinesis-fork", branch: "main" });
    expect(s.setup?.installed).toBe(false);
    expect(s.setup?.changes).toEqual(expect.arrayContaining([".github/workflows/build.yml", "config/adv360.keymap", "tandem/zmk-tandem/src/autoflash.c"]));

    const { session } = await e.install();
    expect(session.setup).toMatchObject({ installed: true, outdated: false });
    const head = fake.head("octocat", "kinesis-fork");
    expect(fake.fileAt(head, ".github/workflows/build.yml")).toContain("-DZMK_EXTRA_MODULES=");
    expect(fake.fileAt(head, "tandem/zmk-tandem/src/autoflash.c")).toBe(MODULE_FILES.find((f) => f.path.endsWith("autoflash.c"))!.content);
  });

  it("finishes when an earlier click already added Tandem", async () => {
    fake.addRepo("octocat", "kinesis-fork", kinesisRepo());
    const e = await engine();
    await e.connect({ owner: "octocat", name: "kinesis-fork", branch: "main" });
    const before = fake.head("octocat", "kinesis-fork");
    await e.install();
    const after = fake.head("octocat", "kinesis-fork");
    // A second click whose branch lookup comes back from before the first one's commit.
    fake.staleHeads.push(before);
    const { session } = await e.install();
    expect(session.setup).toMatchObject({ installed: true, outdated: false });
    expect(fake.head("octocat", "kinesis-fork")).toBe(after);
  });

  it("asks GitHub again rather than trusting the browser's cache", async () => {
    fake.addRepo("octocat", "adv360", tandemRepo());
    const e = await engine();
    await e.connect({ owner: "octocat", name: "adv360", branch: "main" });
    await e.state();
    expect(fake.cacheModes.length).toBeGreaterThan(0);
    expect(new Set(fake.cacheModes)).toEqual(new Set(["no-cache"]));
  });

  it("updates with copying by hand, then reuses the download", async () => {
    fake.addRepo("octocat", "adv360", tandemRepo());
    const e = await engine();
    await e.connect({ owner: "octocat", name: "adv360", branch: "main" });
    const events = record(e);

    const { keymap } = await e.state();
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    await e.update(keymap);
    const files = await until(() => events.find((x) => x.type === "manual-flash"));
    expect(files).toMatchObject({ left: expect.stringMatching(/^blob:/), right: expect.stringMatching(/^blob:/) });
    expect(events).toContainEqual(expect.objectContaining({ type: "step", step: "build", state: "done" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "step", step: "download", state: "done" }));

    await e.act({ type: "manual-flash-done" });
    const head = fake.head("octocat", "adv360").slice(0, 7);
    expect(await until(() => events.find((x) => x.type === "done"))).toEqual({ type: "done", build: head, checked: false });

    // Same commit again: nothing to build or download.
    events.length = 0;
    await e.update();
    await until(() => events.find((x) => x.type === "manual-flash"));
    expect(events).toContainEqual(expect.objectContaining({ type: "step", step: "build", state: "skipped", detail: `Already built ${head}` }));
    await e.act({ type: "manual-flash-done" });
    await until(() => events.find((x) => x.type === "done"));
  });

  it("commits a newer Tandem on top of the layout before building", async () => {
    const files = tandemRepo();
    files["tandem/zmk-tandem/src/reconnect.c"] = "// an older version\n";
    fake.addRepo("octocat", "adv360", files);
    const e = await engine();
    const s = await e.connect({ owner: "octocat", name: "adv360", branch: "main" });
    expect(s.setup).toMatchObject({ outdated: true, changes: ["tandem/zmk-tandem/src/reconnect.c"] });
    const events = record(e);

    const { keymap } = await e.state();
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    await e.update(keymap);
    await until(() => events.find((x) => x.type === "manual-flash"));

    const head = fake.head("octocat", "adv360");
    const commit = fake.commits.get(head)!;
    expect(commit.message).toMatch(/^Update Tandem\n/);
    expect(fake.commits.get(commit.parents[0])!.message).toBe("Update layout with Tandem");
    expect(fake.fileAt(head, "tandem/zmk-tandem/src/reconnect.c")).toBe(MODULE_FILES.find((f) => f.path.endsWith("reconnect.c"))!.content);
    expect(parseKeymap(fake.fileAt(head, "config/adv360.keymap")!).layers[0].bindings[15]).toBe("&ltr 2 Q");
    expect(events).toContainEqual({ type: "step", step: "save", state: "done", detail: `Committed your layout and Tandem's update, ${head.slice(0, 7)}` });

    await e.act({ type: "manual-flash-done" });
    expect(await until(() => events.find((x) => x.type === "done"))).toEqual({ type: "done", build: head.slice(0, 7), checked: false });
    expect((await e.session()).setup).toMatchObject({ installed: true, outdated: false });
  });

  it("still updates the keyboard when the branch can't take a newer Tandem", async () => {
    const files = tandemRepo();
    files["tandem/zmk-tandem/src/reconnect.c"] = "// an older version\n";
    files[".github/workflows/build.yml"] = "name: Build\non: push\n";
    fake.addRepo("octocat", "adv360", files);
    const e = await engine();
    const s = await e.connect({ owner: "octocat", name: "adv360", branch: "main" });
    expect(s.setup).toMatchObject({ outdated: true, blocker: expect.stringMatching(/isn't Kinesis's/) });
    const events = record(e);

    const { keymap } = await e.state();
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    await e.update(keymap);
    await until(() => events.find((x) => x.type === "manual-flash"));

    const head = fake.head("octocat", "adv360");
    expect(fake.commits.get(head)!.message).toBe("Update layout with Tandem");
    expect(fake.fileAt(head, "tandem/zmk-tandem/src/reconnect.c")).toBe("// an older version\n");
    expect(events).toContainEqual({ type: "step", step: "save", state: "done", detail: `Committed ${head.slice(0, 7)}` });
    await e.act({ type: "manual-flash-done" });
    await until(() => events.find((x) => x.type === "done"));
  });

  it("says an update stopped when the page reloaded part way", async () => {
    // sessionStorage outlives a reload; module state doesn't.
    const tab = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => tab.get(k) ?? null,
      setItem: (k: string, v: string) => tab.set(k, v),
      removeItem: (k: string) => tab.delete(k),
    });
    fake.addRepo("octocat", "adv360", tandemRepo());
    const before = await engine();
    await before.connect({ owner: "octocat", name: "adv360", branch: "main" });
    const events = record(before);
    const { keymap } = await before.state();
    keymap.layers[0].bindings[15] = "&ltr 2 Q";
    await before.update(keymap);
    await until(() => events.find((x) => x.type === "manual-flash"));

    const after = await engine();
    const jobs: unknown[] = [];
    after.subscribe((l) => l.type === "job" && jobs.push(l.job));
    expect(jobs).toEqual([
      expect.objectContaining({
        running: false,
        interrupted: true,
        events: expect.arrayContaining([expect.objectContaining({ type: "error", message: expect.stringMatching(/page reloaded/) })]),
      }),
    ]);
    vi.unstubAllGlobals();
  });

  it("creates a repo from the template, with the keyboard's layers", async () => {
    fake.addRepo("itsthecsguy", "tandem-config", tandemRepo(), { template: true });
    vi.resetModules();
    const { createFromTemplate } = await import("../src/engine/newrepo");
    const { GitHubApi } = await import("../shared/github");

    const layers = [
      { name: "Base", bindings: Array(76).fill("&kp A") },
      { name: "Symbols", bindings: Array(76).fill("&trans") },
    ];
    const repo = await createFromTemplate(new GitHubApi("gho_test"), "octocat", { name: "my-layout", private: true, layers });
    expect(repo).toEqual({ owner: "octocat", name: "my-layout", branch: "main" });
    const head = fake.head("octocat", "my-layout");
    expect(fake.commits.get(head)!.message).toBe("Start from the layout on my keyboard");
    expect(parseKeymap(fake.fileAt(head, "config/adv360.keymap")!).layers.map((l) => l.name)).toEqual(["Base", "Symbols"]);
    expect(fake.repos.get("octocat/my-layout")!.private).toBe(true);
  });

  it("starts the build by hand when a new repo's first commit has none", async () => {
    fake.addRepo("itsthecsguy", "tandem-config", tandemRepo(), { template: true });
    const e = await engine();
    const s = await e.newRepo({ name: "fresh", private: false, fromKeyboard: false });
    expect(s.repo).toMatchObject({ owner: "octocat", name: "fresh" });
    expect(fake.runs).toHaveLength(0);

    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const events = record(e);
    await e.update();
    for (let i = 0; i < 30 && !events.some((x) => x.type === "manual-flash"); i++) await vi.advanceTimersByTimeAsync(1000);
    expect(fake.runs.map((r) => r.event)).toEqual(["workflow_dispatch"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "step", step: "download", state: "done" }));
  });
});
