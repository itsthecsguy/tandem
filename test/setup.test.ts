import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { KEYMAP_PATH, MANIFEST_PATH, WORKFLOW_PATH, patchManifest, patchWorkflow, setupPlan, unpatchManifest, unpatchWorkflow } from "../shared/setup";
import { MODULE_FILES } from "../src/engine/module";

const workflow = readFileSync(join(__dirname, "fixtures", "build.yml"), "utf8");

// Kinesis's config/west.yml.
const manifest = `manifest:
  remotes:
    - name: zmkfirmware
      url-base: https://github.com/zmkfirmware
    - name: refil
      url-base: https://github.com/refil
  projects:
    - name: zmk
      remote: refil
      revision: adv360-z3.5-2
      import: app/west.yml
  self:
    path: config
`;

describe("the config template", () => {
  const read = (path: string) => readFileSync(join(__dirname, "..", "template", path), "utf8");

  it("bundles every file of the firmware module", () => {
    expect(MODULE_FILES.map((f) => f.path)).toContain("tandem/zmk-tandem/src/autoflash.c");
    expect(MODULE_FILES.map((f) => f.path)).toContain("tandem/zmk-tandem/zephyr/module.yml");
  });

  // A repo made from the template should need no setup commit.
  it("has Tandem set up already", () => {
    const module = new Map(MODULE_FILES.map((f) => [f.path, read(f.path)]));
    const plan = setupPlan(
      { workflow: read(WORKFLOW_PATH), manifest: read(MANIFEST_PATH), keymap: read(KEYMAP_PATH), info: read("config/info.json"), module },
      MODULE_FILES,
    );
    expect(plan.status).toEqual({ installed: true, outdated: false, changes: [], blocker: null });
  });

  it("shows a repo set up before the faster builds as outdated", () => {
    const module = new Map(MODULE_FILES.map((f) => [f.path, read(f.path)]));
    const before = { workflow: read(WORKFLOW_PATH), manifest, keymap: read(KEYMAP_PATH), info: read("config/info.json"), module };
    const plan = setupPlan(before, MODULE_FILES);
    expect(plan.status).toMatchObject({ installed: false, outdated: true, changes: [MANIFEST_PATH] });
    expect(plan.files[0].content).toBe(read(MANIFEST_PATH));
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

  it("makes shallow clones, cached under a key no old cache matches", () => {
    expect(patched.match(/run: west update --narrow -o=--depth=1$/gm)).toHaveLength(2);
    expect(patched.match(/key: \$\{\{ runner\.os \}\}-build-\$\{\{ env\.cache-name \}\}-tandem-\$\{\{ hashFiles\('config\/west\.yml'\) \}\}$/gm)).toHaveLength(2);
    const restoreKeys = [...patched.matchAll(/restore-keys: \|\n((?: {12}\S.*\n)+)/g)].map((m) => m[1].trim());
    expect(restoreKeys).toEqual(["${{ runner.os }}-build-${{ env.cache-name }}-tandem-", "${{ runner.os }}-build-${{ env.cache-name }}-tandem-"]);
  });
});

describe("patchManifest", () => {
  const patched = patchManifest(manifest);

  it("fetches only the modules the firmware builds from", () => {
    expect(patched).toContain("      import:\n        file: app/west.yml\n        name-allowlist:\n          - zephyr\n");
    expect(patched).toContain("          - hal_nordic\n");
    expect(patched).not.toContain("import: app/west.yml");
  });

  it("keeps everything else, and is a no-op the second time", () => {
    expect(unpatchManifest(patched)).toBe(manifest);
    expect(patchManifest(patched)).toBe(patched);
  });

  it("leaves a ZMK revision it wasn't checked against as Kinesis wrote it", () => {
    const other = manifest.replace("adv360-z3.5-2", "adv360-z4.1");
    expect(patchManifest(other)).toBe(other);
    // Including one that moved on after Tandem patched it.
    expect(patchManifest(patched.replace("adv360-z3.5-2", "adv360-z4.1"))).toBe(other);
  });
});
