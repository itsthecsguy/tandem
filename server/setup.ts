// The one commit that adds Tandem to a keyboard config repo:
//   tandem/zmk-tandem/   the firmware module, copied from this repo
//   build workflow       every `west build` also builds the module, with the
//                        commit's short SHA as the build ID the halves report
//   keymap               a global &lt quick-tap override becomes Tandem's &ltr
//
// This repo is itself a config repo with that commit already applied, so a
// fork of it needs no setup. test/setup.test.ts checks that it stays that way.

import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { SetupStatus } from "../shared/types";
import { importKeymap } from "./keymap";
import { readLayout } from "./layout";

export const MODULE_PATH = "tandem/zmk-tandem";
/** The module in this repo, which setup copies into other repos. */
export const MODULE_DIR = resolve(import.meta.dirname, "..", MODULE_PATH);
export const WORKFLOW_PATH = ".github/workflows/build.yml";
export const KEYMAP_PATH = "config/adv360.keymap";
const BUILD_ID_CONF = "tandem/build-id.conf";

const BUILD_FLAGS = [
  `-DZMK_EXTRA_MODULES="\${GITHUB_WORKSPACE}/${MODULE_PATH}"`,
  `-DEXTRA_DTC_OVERLAY_FILE="\${GITHUB_WORKSPACE}/${MODULE_PATH}/tandem.overlay"`,
  `"-DEXTRA_CONF_FILE=\${GITHUB_WORKSPACE}/${MODULE_PATH}/tandem.conf;\${GITHUB_WORKSPACE}/${BUILD_ID_CONF}"`,
].join(" ");

export async function moduleFiles(): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push({ path: `${MODULE_PATH}/${relative(MODULE_DIR, full)}`, content: await readFile(full, "utf8") });
    }
  }
  await walk(MODULE_DIR);
  return out.sort((a, b) => a.path.localeCompare(b.path));
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
    out.push(lines[i].replace(/ -DZMK_EXTRA_MODULES="\$\{GITHUB_WORKSPACE\}\/tandem\/zmk-tandem".*?build-id\.conf"/, ""));
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

  for (const line of lines) {
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
    out.push(line);
  }

  return builds > 0 && idSteps > 0 ? out.join("\n") : null;
}

export interface RepoFiles {
  workflow: string | null;
  keymap: string | null;
  info: string | null;
  module: Map<string, string | null>;
}

export async function setupPlan(repo: RepoFiles): Promise<{ status: SetupStatus; files: { path: string; content: string }[] }> {
  const files: { path: string; content: string }[] = [];
  const mine = await moduleFiles();

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

  if (repo.keymap && repo.info) {
    const { rows } = readLayout(repo.info);
    const { text } = importKeymap(repo.keymap, rows);
    if (text !== repo.keymap) files.push({ path: KEYMAP_PATH, content: text });
  }

  // Any earlier version of Tandem counts as present, so it shows as an update.
  const present = [...repo.module.values()].some((v) => v !== null) || !!repo.workflow?.includes(MODULE_PATH);
  return {
    status: {
      installed: present && !moduleChanged && !workflowChanged,
      outdated: present && (moduleChanged || workflowChanged),
      changes: files.map((f) => f.path),
      blocker,
    },
    files,
  };
}
