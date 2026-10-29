// Following a firmware build on GitHub, against an in-memory GitHub.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitHubApi } from "../shared/github";
import type { JobEvent } from "../shared/types";
import { cloudBuild } from "../src/engine/builds";
import { FakeGitHub } from "./fakes/github";

let fake: FakeGitHub;
let restore: () => void;

beforeEach(() => {
  fake = new FakeGitHub();
  restore = fake.install();
});

afterEach(() => restore());

const text = (uf2: Uint8Array) => new TextDecoder().decode(uf2.subarray(32, 32 + 256)).replace(/\0+$/, "");

describe("cloudBuild", () => {
  it("downloads the firmware once it's uploaded, while the job still saves its cache", async () => {
    const sha = fake.addRepo("octocat", "kb", { "config/adv360.keymap": "" });
    fake.savingCache = true;
    fake.build(sha);

    const events: JobEvent[] = [];
    const build = await cloudBuild(
      new GitHubApi("token"),
      { owner: "octocat", name: "kb", branch: "main" },
      sha,
      { studio: false },
      (e) => events.push(e),
      new AbortController().signal,
    );

    expect(text(build.left)).toBe(`left-legacy:${sha.slice(0, 7)}`);
    expect(text(build.right)).toBe(`right-legacy:${sha.slice(0, 7)}`);
    expect(events).toContainEqual({ type: "step", step: "build", state: "done", detail: `Built ${sha.slice(0, 7)}` });
  });
});
