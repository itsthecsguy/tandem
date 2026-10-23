// The one commit that adds Tandem to a keyboard config repo:
//   tandem/zmk-tandem/   the firmware module
//   build workflow       every `west build` also builds the module, with the
//                        commit's short SHA as the build ID the halves report
//   keymap               a global &lt quick-tap override becomes Tandem's &ltr
//
// The browser and the helper both use this. Each passes in the module's files,
// since only the helper can read them from disk.

import { importKeymap } from "./keymap";
import { readLayout } from "./layout";
import type { SetupStatus } from "./types";

export const MODULE_PATH = "tandem/zmk-tandem";
export const WORKFLOW_PATH = ".github/workflows/build.yml";
export const KEYMAP_PATH = "config/adv360.keymap";
const BUILD_ID_CONF = "tandem/build-id.conf";

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
