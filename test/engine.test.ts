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
