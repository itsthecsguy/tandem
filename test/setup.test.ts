import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CHANGELOG } from "../shared/changelog";
import pins from "../shared/pins.json";
import { KEYMAP_PATH, MANIFEST_PATH, VERSION_PATH, WORKFLOW_PATH, committedDetail, patchManifest, patchWorkflow, setupMessage, setupPlan, unpatchManifest, unpatchWorkflow } from "../shared/setup";
import { KINESIS_BASE_PATH } from "../shared/sync";
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
    expect(MODULE_FILES.map((f) => f.path)).toContain("tandem/zmk-tandem/src/reconnect.c");
    expect(MODULE_FILES.map((f) => f.path)).toContain("tandem/zmk-tandem/zephyr/module.yml");
  });

  // A repo made from the template should need no setup commit.
  it("has Tandem set up already", () => {
    const module = new Map(MODULE_FILES.map((f) => [f.path, read(f.path)]));
    const plan = setupPlan(
      { workflow: read(WORKFLOW_PATH), manifest: read(MANIFEST_PATH), keymap: read(KEYMAP_PATH), info: read("config/info.json"), module },
      MODULE_FILES,
    );
    expect(plan.status).toEqual({ installed: true, outdated: false, changes: [], blocker: null, version: CHANGELOG[0].version, latest: CHANGELOG[0].version, held: false });
  });

  it("is on the release the changelog's newest entry describes", () => {
    expect(read(VERSION_PATH).trim()).toBe(String(CHANGELOG[0].version));
    expect(CHANGELOG.map((r) => r.version)).toEqual([...CHANGELOG.map((r) => r.version)].sort((a, b) => b - a));
  });

  it("builds its firmware check in the image users build in", () => {
    const check = readFileSync(join(__dirname, "..", ".github/workflows/firmware.yml"), "utf8");
    expect(check).toContain(`image: ${pins.image.name}:${pins.image.tag}@${pins.image.digest}\n`);
  });

  it("records the Kinesis commit it was made from", () => {
    expect(read(KINESIS_BASE_PATH).trim()).toBe(pins.kinesis.sha);
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

  it("builds in the Docker image Tandem tested", () => {
    expect(patched.match(new RegExp(`image: zmkfirmware/zmk-build-arm:stable@${pins.image.digest}$`, "gm"))).toHaveLength(2);
  });

  it("keeps someone's own pinned image", () => {
    const own = workflow.replaceAll("zmk-build-arm:stable", "zmk-build-arm:3.5@sha256:abc123");
    expect(unpatchWorkflow(patchWorkflow(own)!)).toBe(own);
    expect(patchWorkflow(own)).toContain("zmk-build-arm:3.5@sha256:abc123");
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

  it("pins ZMK and Zephyr to the commits Tandem tested", () => {
    expect(patched).toContain(`revision: ${pins.zmk.sha} # Tandem's tested commit of adv360-z3.5-2\n`);
    expect(patched).toContain(`    - name: zephyr # Tandem's tested commit of ${pins.zephyr.branch}\n      remote: zmkfirmware\n      revision: ${pins.zephyr.sha}\n`);
    expect(patched).not.toContain("revision: adv360-z3.5-2");
  });

  it("upgrades a manifest with only the allowlist from an older Tandem", () => {
    const older = manifest.replace("import: app/west.yml", "import:\n        file: app/west.yml\n        name-allowlist:\n          - zephyr\n          - cmsis");
    expect(patchManifest(older)).toBe(patched);
  });

  it("leaves someone's own ZMK fork alone, even on a branch of the same name", () => {
    const own = manifest.replace("remote: refil", "remote: octocat").replace("    - name: refil\n      url-base: https://github.com/refil", "    - name: octocat\n      url-base: https://github.com/octocat");
    expect(patchManifest(own)).toBe(own);
  });

  it("leaves a manifest alone that has its own Zephyr, or lacks the remote for one", () => {
    const zephyr = manifest.replace("  projects:\n", "  projects:\n    - name: zephyr\n      remote: zmkfirmware\n      revision: mine\n");
    expect(patchManifest(zephyr)).toBe(zephyr);
    const noRemote = manifest.replace("    - name: zmkfirmware\n      url-base: https://github.com/zmkfirmware\n", "");
    expect(patchManifest(noRemote)).toBe(noRemote);
  });

  it("leaves a ZMK revision it wasn't checked against as Kinesis wrote it", () => {
    const other = manifest.replace("adv360-z3.5-2", "adv360-z4.1");
    expect(patchManifest(other)).toBe(other);
    // Including one that moved on after Tandem patched it.
    expect(patchManifest(patched.replace("adv360-z3.5-2", "adv360-z4.1"))).toBe(other);
  });
});

describe("setup messages", () => {
  it("names the release an update brings", () => {
    const status = { installed: false, outdated: true, changes: [], blocker: null, version: 3, latest: 4, held: false };
    expect(setupMessage(status)).toMatch(/^Update Tandem to release 4\n/);
    expect(setupMessage({ ...status, outdated: false })).toMatch(/^Add Tandem automatic updates\n/);
  });

  it("says what an update committed", () => {
    expect(committedDetail("abcdef1234", { layout: true, kinesis: false, tandem: false })).toBe("Committed abcdef1");
    expect(committedDetail("abcdef1234", { layout: false, kinesis: false, tandem: true })).toBe("Committed Tandem's update, abcdef1");
    expect(committedDetail("abcdef1234", { layout: true, kinesis: false, tandem: true })).toBe("Committed your layout and Tandem's update, abcdef1");
    expect(committedDetail("abcdef1234", { layout: true, kinesis: true, tandem: true })).toBe("Committed your layout, Kinesis's changes and Tandem's update, abcdef1");
  });
});
