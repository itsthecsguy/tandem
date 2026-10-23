// Creates a keyboard config repo for someone who doesn't have one, from
// Tandem's config template: Kinesis's config with Tandem already set up. A
// repo made from a template has its own history and can be private, unlike a
// fork of a public repo.

import type { GitHubApi } from "../../shared/github";
import { importKeymap, replaceLayers } from "../../shared/keymap";
import { readLayout } from "../../shared/layout";
import { KEYMAP_PATH } from "../../shared/setup";
import type { Layer, RepoRef } from "../../shared/types";
import { sleep } from "./util";

const [owner, name] = (import.meta.env.VITE_TEMPLATE_REPO ?? "itsthecsguy/tandem-config").split("/");
export const TEMPLATE = { owner, name };

export interface NewRepoOptions {
  name: string;
  private: boolean;
  /** Layers read from the keyboard. Without them, Kinesis's default layout is used. */
  layers?: Omit<Layer, "node">[];
  /** The exact keymap file a Tandem keyboard reported, which wins over `layers`. */
  keymapText?: string;
}

export async function createFromTemplate(gh: GitHubApi, login: string, options: NewRepoOptions): Promise<RepoRef> {
  const repo = await gh.generate(TEMPLATE, {
    owner: login,
    name: options.name,
    private: options.private,
    description: "Kinesis Advantage 360 Pro layout, managed with Tandem",
  });

  // GitHub copies the template's files in the background.
  let head: string | null = null;
  for (let i = 0; i < 30 && !head; i++) {
    head = await gh.head(repo.owner, repo.name, repo.defaultBranch).catch(() => null);
    if (!head) await sleep(1000);
  }
  if (!head) throw new Error(`GitHub created ${repo.fullName} but its files haven't appeared yet. Wait a moment, then choose it as a repo you have.`);

  if (options.keymapText || options.layers) {
    const [keymap, info] = await Promise.all([
      gh.file(repo.owner, repo.name, KEYMAP_PATH, head),
      gh.file(repo.owner, repo.name, "config/info.json", head),
    ]);
    if (!keymap || !info) throw new Error(`The template is missing ${KEYMAP_PATH} or config/info.json.`);
    const { rows } = readLayout(info);
    const text = importKeymap(options.keymapText ?? replaceLayers(keymap, options.layers!, rows), rows).text;
    if (text !== keymap) {
      await gh.commit(repo.owner, repo.name, repo.defaultBranch, head, [{ path: KEYMAP_PATH, content: text }], "Start from the layout on my keyboard");
    }
  }
  return { owner: repo.owner, name: repo.name, branch: repo.defaultBranch };
}
