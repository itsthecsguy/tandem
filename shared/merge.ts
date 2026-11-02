// A three-way merge of text files, line by line, like git's. Tandem has no git
// checkout to run it in. It brings Kinesis's changes into a file the user or
// Tandem also changed.

// Past this, comparing every line with every other gets slow. Config files
// are nowhere near it, and a file this big just counts as a conflict.
const MAX_CELLS = 16_000_000;

const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** For each line of `a`, the line of `b` it lines up with, from a longest common subsequence. */
function align(a: string[], b: string[]): Int32Array | null {
  const out = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    out[start] = start;
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) out[--endA] = --endB;

  const rows = endA - start;
  const cols = endB - start;
  if (rows * cols > MAX_CELLS) return null;
  const width = cols + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < rows && j < cols; ) {
    if (a[start + i] === b[start + j]) out[start + i++] = start + j++;
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  return out;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

/** Merges `theirs` into `ours`. Null if both changed the same lines differently. */
export function merge3(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs || base === theirs) return ours;
  if (base === ours) return theirs;

  const b = lines(base);
  const o = lines(ours);
  const t = lines(theirs);
  const toOurs = align(b, o);
  const toTheirs = align(b, t);
  if (!toOurs || !toTheirs) return null;

  const out: string[] = [];
  let atBase = 0;
  let atOurs = 0;
  let atTheirs = 0;
  // Lines of the base both sides kept split the files into stretches, and each
  // stretch needs only one side's changes.
  for (let i = 0; i <= b.length; i++) {
    const anchored = i === b.length || (toOurs[i] >= 0 && toTheirs[i] >= 0);
    if (!anchored) continue;
    const nextOurs = i === b.length ? o.length : toOurs[i];
    const nextTheirs = i === b.length ? t.length : toTheirs[i];
    const was = b.slice(atBase, i);
    const mine = o.slice(atOurs, nextOurs);
    const other = t.slice(atTheirs, nextTheirs);
    if (same(mine, was)) out.push(...other);
    else if (same(other, was) || same(mine, other)) out.push(...mine);
    else return null;
    if (i < b.length) out.push(b[i]);
    atBase = i + 1;
    atOurs = nextOurs + 1;
    atTheirs = nextTheirs + 1;
  }
  return out.join("");
}
