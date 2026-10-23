// Creates a keyboard config repo for someone who doesn't have one: Kinesis's
// current config with Tandem added, in a fresh repo under their account. Not
// a fork, because GitHub allows one fork per repo network per account, and
// anyone who already forked Kinesis's repo would just get their old fork back.

import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { Layer, LayoutKey, RepoRef } from "../shared/types";
import type { GitHub } from "./github";
import { importKeymap, replaceLayers } from "../shared/keymap";
import { readLayout } from "../shared/layout";
import { KEYMAP_PATH, WORKFLOW_PATH, moduleFiles, patchWorkflow } from "./setup";

export const TEMPLATE = { owner: "KinesisCorporation", name: "Adv360-Pro-ZMK", ref: "V3.0" };

interface RepoFile {
  path: string;
  data: Buffer;
  executable: boolean;
}

async function walk(root: string, dir = root, out: RepoFile[] = []): Promise<RepoFile[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) {
      out.push({ path: relative(root, full), data: await readFile(full), executable: ((await stat(full)).mode & 0o111) !== 0 });
    }
  }
  return out;
}

let templateLayout: { keys: LayoutKey[]; rows: number[] } | null = null;

/** Kinesis's physical layout, for previewing a layout before any repo exists. */
export async function kinesisLayout(gh: GitHub): Promise<{ keys: LayoutKey[]; rows: number[] }> {
  if (templateLayout) return templateLayout;
  const info = await gh.file(TEMPLATE.owner, TEMPLATE.name, "config/info.json", TEMPLATE.ref);
  if (!info) throw new Error("Couldn't read Kinesis's keyboard layout");
  templateLayout = readLayout(info);
  return templateLayout;
}

export interface NewRepoOptions {
  name: string;
  private: boolean;
  /** Layers read from the keyboard. Without them, Kinesis's default layout is used. */
  layers?: Omit<Layer, "node">[];
  /** The exact keymap file a Tandem keyboard reported, which wins over `layers`. */
  keymapText?: string;
}

/** Kinesis's config with Tandem applied: every file the new repo starts with. */
export async function templateFiles(gh: GitHub, options: Omit<NewRepoOptions, "name" | "private">): Promise<RepoFile[]> {
  const tmp = await mkdtemp(join(tmpdir(), "tandem-template-"));
  try {
    const dir = join(tmp, "repo");
    await gh.downloadRepo(TEMPLATE.owner, TEMPLATE.name, TEMPLATE.ref, dir);
    const files = await walk(dir);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const text = (path: string) => byPath.get(path)?.data.toString("utf8");

    const workflow = text(WORKFLOW_PATH);
    const patched = workflow && patchWorkflow(workflow);
    if (!patched) throw new Error("Kinesis's build workflow changed shape, so Tandem can't add itself to it");
    byPath.get(WORKFLOW_PATH)!.data = Buffer.from(patched);

    const { rows } = readLayout(text("config/info.json") ?? "");
    let keymap = text(KEYMAP_PATH);
    if (!keymap) throw new Error(`Kinesis's config has no ${KEYMAP_PATH}`);
    if (options.keymapText) keymap = options.keymapText;
    else if (options.layers) keymap = replaceLayers(keymap, options.layers, rows);
    byPath.get(KEYMAP_PATH)!.data = Buffer.from(importKeymap(keymap, rows).text);

    for (const f of await moduleFiles()) byPath.set(f.path, { path: f.path, data: Buffer.from(f.content), executable: false });
    return [...byPath.values()];
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function createRepo(gh: GitHub, options: NewRepoOptions): Promise<RepoRef> {
  const files = await templateFiles(gh, options);
  {
    const repo = await gh.createRepo(options.name, options.private, "Kinesis Advantage 360 Pro layout, managed with Tandem");
    // The first commit can take a moment to show up.
    let parent: string | null = null;
    for (let i = 0; i < 10 && !parent; i++) {
      parent = await gh.head(repo.owner, repo.name, repo.defaultBranch).catch(() => null);
      if (!parent) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!parent) throw new Error("GitHub created the repo but its branch didn't appear");

    await gh.commitTree(
      repo.owner,
      repo.name,
      repo.defaultBranch,
      parent,
      files,
      `Start from Kinesis's Adv360 Pro config, with Tandem\n\nCopied from ${TEMPLATE.owner}/${TEMPLATE.name}@${TEMPLATE.ref}.`,
    );
    return { owner: repo.owner, name: repo.name, branch: repo.defaultBranch };
  }
}
