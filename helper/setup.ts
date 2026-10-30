// The helper's side of setup: it reads the module from this repo on disk.

import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { MODULE_PATH, type RepoFile, type RepoFiles, setupPlan as plan } from "../shared/setup";

export { KEYMAP_PATH, MANIFEST_PATH, MODULE_PATH, WORKFLOW_PATH, patchWorkflow, setupMessage, unpatchWorkflow } from "../shared/setup";

/** The module in this repo's config template, which setup copies into other repos. */
export const MODULE_DIR = resolve(import.meta.dirname, "..", "template", MODULE_PATH);

export async function moduleFiles(): Promise<RepoFile[]> {
  const out: RepoFile[] = [];
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

export async function setupPlan(repo: RepoFiles) {
  return plan(repo, await moduleFiles());
}
