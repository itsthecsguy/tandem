import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { KEYMAP_PATH, WORKFLOW_PATH, patchWorkflow, setupPlan, unpatchWorkflow } from "../shared/setup";
import { MODULE_FILES } from "../src/engine/module";

const workflow = readFileSync(join(__dirname, "fixtures", "build.yml"), "utf8");

describe("the config template", () => {
  const read = (path: string) => readFileSync(join(__dirname, "..", "template", path), "utf8");

  it("bundles every file of the firmware module", () => {
    expect(MODULE_FILES.map((f) => f.path)).toContain("tandem/zmk-tandem/src/autoflash.c");
    expect(MODULE_FILES.map((f) => f.path)).toContain("tandem/zmk-tandem/zephyr/module.yml");
  });

  // A repo made from the template should need no setup commit.
  it("has Tandem set up already", () => {
    const module = new Map(MODULE_FILES.map((f) => [f.path, read(f.path)]));
    const plan = setupPlan({ workflow: read(WORKFLOW_PATH), keymap: read(KEYMAP_PATH), info: read("config/info.json"), module }, MODULE_FILES);
    expect(plan.status).toEqual({ installed: true, outdated: false, changes: [], blocker: null });
  });
});

describe("patchWorkflow", () => {
  const patched = patchWorkflow(workflow)!;

  it("adds the module to all four west builds", () => {
    expect(patched).not.toBeNull();
    expect(patched.match(/-DZMK_EXTRA_MODULES=/g)).toHaveLength(4);
    expect(patched.match(/tandem\.overlay/g)).toHaveLength(4);
  });

  it("writes the build ID and repo once per job", () => {
    expect(patched.match(/- name: Tandem build ID/g)).toHaveLength(2);
    expect(patched).toContain('CONFIG_TANDEM_BUILD_ID=\\"$(echo ${{ github.sha }} | cut -c1-7)\\"');
    expect(patched).toContain('CONFIG_TANDEM_REPO=\\"${{ github.repository }}\\"');
  });

  it("keeps everything else", () => {
    expect(unpatchWorkflow(patched)).toBe(workflow);
  });

  it("is a no-op the second time", () => {
    expect(patchWorkflow(patched)).toBe(patched);
  });

  it("upgrades a workflow patched by the first version of Tandem", () => {
    const v1 = workflow
      .replace(
        /^(\s*)- name: Cache west modules$/gm,
        '$1- name: Tandem build ID\n$1  run: mkdir -p tandem && echo "CONFIG_TANDEM_BUILD_ID=\\"$(echo ${{ github.sha }} | cut -c1-7)\\"" > tandem/build-id.conf\n$1- name: Cache west modules',
      )
      .replace(
        /-DZMK_CONFIG="\$\{GITHUB_WORKSPACE\}\/config"/g,
        '-DZMK_CONFIG="${GITHUB_WORKSPACE}/config" -DZMK_EXTRA_MODULES="${GITHUB_WORKSPACE}/tandem/zmk-tandem" -DEXTRA_DTC_OVERLAY_FILE="${GITHUB_WORKSPACE}/tandem/zmk-tandem/tandem.overlay" "-DEXTRA_CONF_FILE=${GITHUB_WORKSPACE}/tandem/zmk-tandem/tandem.conf;${GITHUB_WORKSPACE}/tandem/build-id.conf"',
      );
    expect(patchWorkflow(v1)).toBe(patched);
  });

  it("refuses a workflow it doesn't recognize", () => {
    expect(patchWorkflow("on: push\njobs: {}\n")).toBeNull();
  });
});
