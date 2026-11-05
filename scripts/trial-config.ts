// Makes the ZMK 4.1 trial's config from template/, the way Tandem makes a
// user's trial branch: the same merge of the port's changes as shared/beta.ts,
// read from local git instead of GitHub. CI builds the result with
// build-template.sh, so a pin or module change that breaks the trial shows up
// before a release does.
//   npx tsx scripts/trial-config.ts <checkout of the port, with history> <out dir>

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GitHubApi, TreeEntry } from "../shared/github";
import pins from "../shared/pins.json";
import { planMerge } from "../shared/sync";

const [portDir, outDir] = process.argv.slice(2);
if (!portDir || !outDir) throw new Error("Usage: trial-config.ts <port checkout> <out dir>");

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { maxBuffer: 64 << 20 });

// The template as Git tracks it, not whatever a local build left in template/.
const root = fileURLToPath(new URL("..", import.meta.url));
const tree = git(root, "write-tree", "--prefix=template/").toString().trim();
mkdirSync(outDir, { recursive: true });
execFileSync("tar", ["-x", "-C", outDir], { input: git(root, "archive", tree) });

const dirOf = (owner: string) => (owner === "port" ? portDir : root);
const local = {
  async tree(owner: string, _name: string, ref: string) {
    const lines = git(dirOf(owner), "ls-tree", "-r", ref).toString().trim().split("\n");
    const entries = new Map<string, TreeEntry>();
    for (const line of lines) {
      const [info, path] = line.split("\t");
      const [mode, type, sha] = info.split(" ");
      if (type === "blob") entries.set(path, { path, mode, sha });
    }
    return entries;
  },
  async blob(owner: string, _name: string, sha: string) {
    return new Uint8Array(git(dirOf(owner), "cat-file", "blob", sha));
  },
} as unknown as GitHubApi;

const repo = { owner: "ours", name: "trial", branch: "trial" };
const { changes, kept, conflicts } = await planMerge(local, repo, tree, { owner: "port", name: "port" }, pins.beta.base, pins.beta.sha);
if (conflicts.length) throw new Error(`The port clashes with the template in ${conflicts.join(", ")}`);

for (const change of changes) {
  const path = join(outDir, change.path);
  if ("upstreamBlob" in change) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, git(portDir, "cat-file", "blob", change.upstreamBlob));
  } else if ("content" in change) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, change.content);
  } else if (change.sha === null) {
    rmSync(path, { force: true });
  }
}
console.log(`${changes.length} files from ${pins.beta.repo}@${pins.beta.sha.slice(0, 7)}, kept: ${kept.join(", ") || "none"}`);
