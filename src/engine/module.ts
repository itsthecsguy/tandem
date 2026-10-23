// The firmware module the site installs into repos, bundled at build time so
// the browser never has to fetch it.

import { MODULE_PATH, type RepoFile } from "../../shared/setup";

const SOURCE = "/template/tandem/zmk-tandem/";

const raw = import.meta.glob("/template/tandem/zmk-tandem/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const MODULE_FILES: RepoFile[] = Object.entries(raw)
  .map(([key, content]) => ({ path: `${MODULE_PATH}/${key.slice(SOURCE.length)}`, content }))
  .sort((a, b) => a.path.localeCompare(b.path));
