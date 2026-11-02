// The one commit that adds Tandem to a keyboard config repo:
//   tandem/zmk-tandem/   the firmware module
//   build workflow       every `west build` also builds the module, with the
//                        commit's short SHA as the build ID the halves report.
//                        `west update` makes shallow clones, cached under a
//                        key of Tandem's own.
//   west manifest        fetches only the modules the firmware builds from, at
//                        the commits this release of Tandem was tested with
//   keymap               a global &lt quick-tap override becomes Tandem's &ltr
//
// The browser and the helper both use this. Each passes in the module's files,
// since only the helper can read them from disk.

import { importKeymap } from "./keymap";
import { readLayout } from "./layout";
import pins from "./pins.json";
import type { SetupStatus } from "./types";

export const MODULE_PATH = "tandem/zmk-tandem";
export const VERSION_PATH = `${MODULE_PATH}/version.txt`;
/** Releases the user undid, so an update doesn't put them straight back. */
export const HOLD_PATH = "tandem/hold.json";
export const WORKFLOW_PATH = ".github/workflows/build.yml";
export const KEYMAP_PATH = "config/adv360.keymap";
export const MANIFEST_PATH = "config/west.yml";
const BUILD_ID_CONF = "tandem/build-id.conf";

// Kinesis's `west update` clones every module with its whole history, and the
// cache of that passes 2 GB, which takes half a minute to restore on every
// build. Shallow clones of the modules below make it about 240 MB.
const WEST_UPDATE = "west update";
const SHALLOW_UPDATE = "west update --narrow -o=--depth=1";

// Tandem's caches get their own key, so no build restores the full clones
// Kinesis's workflow cached before, which would then be saved again.
const CACHE_KEY = "${{ runner.os }}-build-${{ env.cache-name }}-${{ hashFiles('config/west.yml') }}";
const TANDEM_CACHE_KEY = "${{ runner.os }}-build-${{ env.cache-name }}-tandem-${{ hashFiles('config/west.yml') }}";
const RESTORE_KEYS = ["${{ runner.os }}-build-${{ env.cache-name }}-", "${{ runner.os }}-build-", "${{ runner.os }}-"];
const TANDEM_RESTORE_KEY = "${{ runner.os }}-build-${{ env.cache-name }}-tandem-";

// The modules the Advantage360 Pro's firmware builds from, out of the dozens
// Zephyr lists. With these alone a first build's `west update` takes 13
// seconds instead of 140, and the firmware comes out byte for byte the same,
// apart from the date and commit Kinesis's version macro types. Checked
// against one ZMK revision only: another may need other modules, so its
// manifest stays as Kinesis wrote it.
const MODULES = ["zephyr", "cmsis", "hal_nordic", "tinycrypt", "lvgl", "segger", "nanopb", "zmk-studio-messages"];
const ZEPHYR_MODULES = MODULES.filter((m) => ["cmsis", "hal_nordic", "tinycrypt", "lvgl", "segger"].includes(m));

// Kinesis's manifest and workflow follow two branches and a Docker tag, so one
// commit can build different firmware from one day to the next. Tandem pins
// them to what it tested. See shared/pins.json.
const PIN_NOTE = `# Tandem's tested commit of`;
const ZEPHYR_NOTE = `# Tandem's tested commit of ${pins.zephyr.branch}`;
const IMAGE = `${pins.image.name}:${pins.image.tag}`;

const BUILD_FLAGS = [
  `-DZMK_EXTRA_MODULES="\${GITHUB_WORKSPACE}/${MODULE_PATH}"`,
  `-DEXTRA_DTC_OVERLAY_FILE="\${GITHUB_WORKSPACE}/${MODULE_PATH}/tandem.overlay"`,
  `"-DEXTRA_CONF_FILE=\${GITHUB_WORKSPACE}/${MODULE_PATH}/tandem.conf;\${GITHUB_WORKSPACE}/${BUILD_ID_CONF}"`,
].join(" ");

export interface RepoFile {
  path: string;
  content: string;
}

/** Removes any version of Tandem's changes, so a patch can be applied fresh. */
export function unpatchWorkflow(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*- name: Tandem build ID\s*$/.test(lines[i])) {
      // Skip the step and its indented body.
      const indent = /^(\s*)/.exec(lines[i])![1].length;
      while (i + 1 < lines.length && /^\s*\S/.test(lines[i + 1]) && /^(\s*)/.exec(lines[i + 1])![1].length > indent) i++;
      continue;
    }
    const restore = /^(\s*)restore-keys: \|\s*$/.exec(lines[i]);
    if (restore && lines[i + 1]?.trim() === TANDEM_RESTORE_KEY) {
      const indent = /^(\s*)/.exec(lines[i + 1])![1];
      out.push(lines[i], ...RESTORE_KEYS.map((k) => indent + k));
      i++;
      continue;
    }
    out.push(
      lines[i]
        .replace(new RegExp(`^(\\s*image: ${IMAGE})@sha256:[0-9a-f]+\\s*$`), "$1")
        .replace(/ -DZMK_EXTRA_MODULES="\$\{GITHUB_WORKSPACE\}\/tandem\/zmk-tandem".*?build-id\.conf"/, "")
        .replace(new RegExp(`^(\\s*run: )${SHALLOW_UPDATE}\\s*$`), `$1${WEST_UPDATE}`)
        .replace(`key: ${TANDEM_CACHE_KEY}`, `key: ${CACHE_KEY}`),
    );
  }
  return out.join("\n");
}

/**
 * Adds Tandem to Kinesis's build workflow, replacing any older version of
 * Tandem's changes. Returns null if the workflow doesn't look like Kinesis's,
 * so we don't guess at someone else's.
 */
export function patchWorkflow(original: string): string | null {
  const text = unpatchWorkflow(original);
  const lines = text.split("\n");
  const out: string[] = [];
  let builds = 0;
  let idSteps = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === `image: ${IMAGE}`) {
      out.push(`${line}@${pins.image.digest}`);
      continue;
    }
    // Write the build ID and repo right before each job restores its west cache.
    const cache = /^(\s*)- name: Cache west modules\s*$/.exec(line);
    if (cache) {
      const indent = cache[1];
      out.push(
        `${indent}- name: Tandem build ID`,
        `${indent}  run: |`,
        `${indent}    mkdir -p tandem`,
        `${indent}    echo "CONFIG_TANDEM_BUILD_ID=\\"$(echo \${{ github.sha }} | cut -c1-7)\\"" > ${BUILD_ID_CONF}`,
        `${indent}    echo "CONFIG_TANDEM_REPO=\\"\${{ github.repository }}\\"" >> ${BUILD_ID_CONF}`,
      );
      idSteps++;
    }

    if (/\bwest build\b/.test(line) && line.includes('-DZMK_CONFIG="${GITHUB_WORKSPACE}/config"')) {
      out.push(line.replace('-DZMK_CONFIG="${GITHUB_WORKSPACE}/config"', `-DZMK_CONFIG="\${GITHUB_WORKSPACE}/config" ${BUILD_FLAGS}`));
      builds++;
      continue;
    }

    const update = new RegExp(`^(\\s*run: )${WEST_UPDATE}\\s*$`).exec(line);
    if (update) {
      out.push(update[1] + SHALLOW_UPDATE);
      continue;
    }
    if (line.trim() === `key: ${CACHE_KEY}`) {
      out.push(line.replace(CACHE_KEY, TANDEM_CACHE_KEY));
      continue;
    }
    // Only Kinesis's three restore keys, all of which would match an old cache.
    if (/^\s*restore-keys: \|\s*$/.test(line) && RESTORE_KEYS.every((k, j) => lines[i + 1 + j]?.trim() === k)) {
      out.push(line, /^(\s*)/.exec(lines[i + 1])![1] + TANDEM_RESTORE_KEY);
      i += RESTORE_KEYS.length;
      continue;
    }
    out.push(line);
  }

  return builds > 0 && idSteps > 0 ? out.join("\n") : null;
}

const ZEPHYR_PROJECT = (indent: string) =>
  [
    `${indent}- name: zephyr ${ZEPHYR_NOTE}`,
    `${indent}  remote: zmkfirmware`,
    `${indent}  revision: ${pins.zephyr.sha}`,
    `${indent}  import:`,
    `${indent}    name-allowlist:`,
    ...ZEPHYR_MODULES.map((m) => `${indent}      - ${m}`),
  ].join("\n");

/** Puts the west manifest's ZMK project back the way Kinesis wrote it. */
export function unpatchManifest(text: string): string {
  return text
    .replace(/^( *)- name: zephyr # Tandem's tested commit of \S+\n(?:\1  .*\n)+/m, "")
    .replace(/^( *)revision: [0-9a-f]{40} # Tandem's tested commit of (\S+)$/m, "$1revision: $2")
    .replace(/^( *)import:\n\1  file: app\/west\.yml\n\1  name-allowlist:(?:\n\1    - [\w-]+)+$/m, "$1import: app/west.yml");
}

/**
 * Has the west manifest fetch only the modules the firmware builds from, at
 * the commits Tandem tested, for the ZMK revision those were checked against.
 * Any other manifest comes back as Kinesis wrote it, without an allowlist or a
 * pin from an older Tandem.
 */
export function patchManifest(original: string): string {
  const text = unpatchManifest(original);
  // Exactly Kinesis's ZMK project, from Kinesis's remote. Someone's own fork of
  // ZMK can have a branch of the same name, and Tandem's pin isn't on it.
  const zmk = new RegExp(`^( *)- name: zmk\\n\\1  remote: ${pins.zmk.repo.split("/")[0]}\\n\\1  revision: ${pins.zmk.branch}\\s*\\n\\1  import: app/west\\.yml$`, "m");
  const projects = /^( *)projects:\n( *)(?=- )/m;
  // The pin for Zephyr needs Kinesis's remote for it, and to be the only Zephyr project.
  if (!zmk.test(text) || !projects.test(text) || !/^ *- name: zmkfirmware$/m.test(text) || /^ *- name: zephyr\b/m.test(text)) return text;
  return text
    .replace(zmk, (_, indent: string) =>
      [
        `${indent}- name: zmk`,
        `${indent}  remote: ${pins.zmk.repo.split("/")[0]}`,
        `${indent}  revision: ${pins.zmk.sha} ${PIN_NOTE} ${pins.zmk.branch}`,
        `${indent}  import:`,
        `${indent}    file: app/west.yml`,
        `${indent}    name-allowlist:`,
        ...MODULES.map((m) => `${indent}      - ${m}`),
      ].join("\n"),
    )
    .replace(projects, (m, _, indent: string) => `${m}${ZEPHYR_PROJECT(indent).trimStart()}\n${indent}`);
}

export interface RepoFiles {
  workflow: string | null;
  manifest: string | null;
  keymap: string | null;
  info: string | null;
  module: Map<string, string | null>;
  hold?: string | null;
}

/** The release a set of module files is. Older releases have no version file. */
export function moduleVersion(text: string | null | undefined): number | null {
  const version = Number.parseInt(text ?? "", 10);
  return Number.isNaN(version) ? null : version;
}

/** Which releases the user undid: Tandem's by version, Kinesis's by commit. */
export interface Hold {
  tandem?: number;
  kinesis?: string;
}

export function readHold(text: string | null | undefined): Hold {
  try {
    return (JSON.parse(text ?? "{}") as Hold) ?? {};
  } catch {
    return {};
  }
}

/** What the setup commit would change, given the repo's files and the module Tandem ships. */
export function setupPlan(repo: RepoFiles, mine: RepoFile[]): { status: SetupStatus; files: RepoFile[] } {
  const files: RepoFile[] = [];

  let moduleChanged = false;
  for (const f of mine) {
    if (repo.module.get(f.path) !== f.content) {
      files.push(f);
      moduleChanged = true;
    }
  }

  let blocker: string | null = null;
  if (!repo.workflow) blocker = `This branch has no ${WORKFLOW_PATH}.`;
  else if (!repo.keymap) blocker = `This branch has no ${KEYMAP_PATH}.`;
  else if (!repo.info) blocker = "This branch has no config/info.json.";

  let workflowChanged = false;
  if (repo.workflow) {
    const patched = patchWorkflow(repo.workflow);
    if (patched === null) blocker ??= "The build workflow isn't Kinesis's, so Tandem can't add itself to it safely.";
    else if (patched !== repo.workflow) {
      files.push({ path: WORKFLOW_PATH, content: patched });
      workflowChanged = true;
    }
  }

  // Builds work either way, so a manifest Tandem can't patch is no blocker.
  let manifestChanged = false;
  if (repo.manifest) {
    const patched = patchManifest(repo.manifest);
    if (patched !== repo.manifest) {
      files.push({ path: MANIFEST_PATH, content: patched });
      manifestChanged = true;
    }
  }

  if (repo.keymap && repo.info) {
    const { rows } = readLayout(repo.info);
    const { text } = importKeymap(repo.keymap, rows);
    if (text !== repo.keymap) files.push({ path: KEYMAP_PATH, content: text });
  }

  // Any earlier version of Tandem counts as present, so it shows as an update.
  const present = [...repo.module.values()].some((v) => v !== null) || !!repo.workflow?.includes(MODULE_PATH);
  const outdated = present && (moduleChanged || workflowChanged || manifestChanged);
  const latest = moduleVersion(mine.find((f) => f.path === VERSION_PATH)?.content);
  return {
    status: {
      installed: present && !moduleChanged && !workflowChanged && !manifestChanged,
      outdated,
      changes: files.map((f) => f.path),
      blocker,
      version: moduleVersion(repo.module.get(VERSION_PATH)),
      latest,
      held: outdated && latest !== null && readHold(repo.hold).tandem === latest,
    },
    files,
  };
}

/** The setup commit's message, for adding Tandem or replacing an older version. */
export function setupMessage(status: SetupStatus): string {
  return status.outdated
    ? `Update Tandem${status.latest === null ? "" : ` to release ${status.latest}`}\n\nReplaces the zmk-tandem firmware module, and Tandem's changes to the build\nand keymap, with the latest version.`
    : "Add Tandem automatic updates\n\nAdds the zmk-tandem firmware module, builds it in every firmware build, and\nmoves the keymap's repeat-on-tap-then-hold keys to Tandem's &ltr behavior.";
}

/** What an update's commit step says it did. A layout alone needs no explaining. */
export function committedDetail(sha: string, what: { layout: boolean; kinesis: boolean; tandem: boolean }): string {
  const parts = [what.layout && "your layout", what.kinesis && "Kinesis's changes", what.tandem && "Tandem's update"].filter((p): p is string => !!p);
  if (!what.kinesis && !what.tandem) return `Committed ${sha.slice(0, 7)}`;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `Committed ${list}, ${sha.slice(0, 7)}`;
}
