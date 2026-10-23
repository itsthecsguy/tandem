import type { LayoutKey } from "./types";

interface InfoKey {
  label?: string;
  row: number;
  col: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  r?: number;
  rx?: number;
  ry?: number;
}

/** Reads a QMK-style info.json, as shipped in Kinesis's config repo. */
export function readLayout(infoJson: string): { keys: LayoutKey[]; rows: number[] } {
  const info = JSON.parse(infoJson);
  const layout: InfoKey[] = Object.values(info.layouts as Record<string, { layout: InfoKey[] }>)[0].layout;

  const keys = layout.map((k, index) => ({
    index,
    label: k.label ?? "",
    row: k.row,
    col: k.col,
    x: k.x,
    y: k.y,
    w: k.w ?? 1,
    h: k.h ?? 1,
    r: k.r ?? 0,
    rx: k.rx ?? 0,
    ry: k.ry ?? 0,
  }));

  // Keymap rows follow the order of keys in the layout, grouped by matrix row.
  const rows: number[] = [];
  let current = -1;
  for (const k of keys) {
    if (k.row !== current) {
      rows.push(0);
      current = k.row;
    }
    rows[rows.length - 1]++;
  }
  return { keys, rows };
}
