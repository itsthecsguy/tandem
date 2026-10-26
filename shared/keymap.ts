// Reads and writes ZMK .keymap files. Only two parts of the file change on
// write: the contents of each layer's `bindings = < ... >`, and Tandem's
// marked block of behavior definitions. Everything else stays byte for byte.

import { sameBinding } from "./bindings";
import type { Keymap, Layer, RepeatTiming } from "./types";

export const DEFAULT_REPEAT: RepeatTiming = { tappingTermMs: 200, quickTapMs: 200 };

const BEGIN = "/* tandem:begin */";
const END = "/* tandem:end */";

interface Span {
  start: number;
  end: number;
}

interface ParsedLayer extends Layer {
  /** Text between `bindings = <` and `>`. */
  content: Span;
  /** The whole node, from the start of its first line to the end of its last. */
  nodeSpan: Span;
  /** The text inside the quotes of `display-name = "..."`, if the node has one. */
  displayName: Span | null;
  /** Start of the line holding `bindings = <`. */
  bindingsLine: number;
}

export interface ParsedKeymap {
  layers: ParsedLayer[];
  repeat: RepeatTiming;
  /** Tandem's marked block, including the markers. */
  managed: Span | null;
  /** Position of the `}` that closes the behaviors node. */
  behaviorsClose: number | null;
  /** Start of the line holding `keymap {`. */
  keymapLineStart: number;
  /** Everything between the keymap node's braces. */
  keymapBody: Span;
  /** A global `&lt { quick-tap-ms = <N>; };` override, if present. */
  ltOverride: (Span & Partial<RepeatTiming>) | null;
}

// Returns the index just past a comment or string starting at i, or i.
function skipNonCode(text: string, i: number): number {
  if (text.startsWith("/*", i)) {
    const e = text.indexOf("*/", i + 2);
    return e < 0 ? text.length : e + 2;
  }
  if (text.startsWith("//", i)) {
    const e = text.indexOf("\n", i + 2);
    return e < 0 ? text.length : e;
  }
  if (text[i] === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  return i;
}

// Same length as text, with comments and strings blanked out, so regexes
// and brace matching only see code. Newlines are kept.
function maskNonCode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const j = skipNonCode(text, i);
    if (j !== i) {
      out += text.slice(i, j).replace(/[^\n]/g, " ");
      i = j;
    } else {
      out += text[i++];
    }
  }
  return out;
}

function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return i;
  }
  throw new Error("The keymap has an unclosed {");
}

function findNodeOpen(code: string, name: string, from = 0): number | null {
  const re = new RegExp(`(?:^|[\\s;{}:])${name}\\s*\\{`, "g");
  re.lastIndex = from;
  const m = re.exec(code);
  return m ? m.index + m[0].length - 1 : null;
}

// Direct children of the node whose `{` is at `open`.
function childNodes(code: string, open: number, close: number): { name: string; open: number; close: number; header: number }[] {
  const children = [];
  let headerStart = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = code[i];
    if (c === ";") {
      headerStart = i + 1;
    } else if (c === "{") {
      const end = matchBrace(code, i);
      const header = code.slice(headerStart, i).trim();
      const name = header.split(":").pop()!.trim();
      const firstChar = headerStart + code.slice(headerStart, i).search(/\S/);
      children.push({ name, open: i, close: end, header: firstChar });
      i = end;
      headerStart = end + 1;
    }
  }
  return children;
}

export function layerName(node: string, displayName?: string): string {
  if (displayName) return displayName;
  const base = node.replace(/^layer_/, "").replace(/_layer$/, "");
  if (base === "default") return "Base";
  if (/^\d+$/.test(base)) return `Layer ${base}`;
  return base
    .split("_")
    .map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function splitBindings(content: string): string[] {
  return (maskNonCode(content).match(/&[^&]+/g) ?? []).map((s) => s.trim().replace(/\s+/g, " "));
}

function readMs(text: string, prop: string): number | undefined {
  const m = new RegExp(`${prop}\\s*=\\s*<\\s*(\\d+)\\s*>`).exec(text);
  return m ? Number(m[1]) : undefined;
}

export function parseKeymap(text: string): ParsedKeymap {
  const code = maskNonCode(text);

  const keymapOpen = findNodeOpen(code, "keymap");
  if (keymapOpen === null) throw new Error("No keymap { } node found");
  const keymapClose = matchBrace(code, keymapOpen);

  const layers: ParsedLayer[] = [];
  for (const child of childNodes(code, keymapOpen, keymapClose)) {
    const body = code.slice(child.open, child.close);
    const b = /(?:^|[^\w-])bindings\s*=\s*</.exec(body);
    if (!b) continue;
    const start = child.open + b.index + b[0].length;
    const end = code.indexOf(">", start);
    if (end < 0 || end > child.close) throw new Error(`Layer ${child.name} has an unclosed bindings list`);

    // Find the property in code, then read its value from the real text: the
    // masked copy has the string blanked out.
    const dn = /(?:^|[^\w-])display-name\s*=/.exec(body);
    let displayName: Span | null = null;
    if (dn) {
      const at = child.open + dn.index + dn[0].length;
      const m = /^\s*"([^"]*)"/.exec(text.slice(at));
      if (m) {
        const start = at + m[0].indexOf('"') + 1;
        displayName = { start, end: start + m[1].length };
      }
    }

    // The node runs from its header line through the line with its "};".
    const semicolon = code.indexOf(";", child.close);
    const lineEnd = text.indexOf("\n", semicolon);
    const nodeSpan = { start: text.lastIndexOf("\n", child.header) + 1, end: lineEnd < 0 ? text.length : lineEnd + 1 };

    layers.push({
      node: child.name,
      name: layerName(child.name, displayName ? text.slice(displayName.start, displayName.end) : undefined),
      bindings: splitBindings(text.slice(start, end)),
      content: { start, end },
      nodeSpan,
      displayName,
      bindingsLine: text.lastIndexOf("\n", child.open + b.index + b[0].indexOf("bindings")) + 1,
    });
  }

  let managed: Span | null = null;
  let behaviorsClose: number | null = null;
  const behaviorsOpen = findNodeOpen(code, "behaviors");
  if (behaviorsOpen !== null) {
    behaviorsClose = matchBrace(code, behaviorsOpen);
    const begin = text.indexOf(BEGIN, behaviorsOpen);
    const end = text.indexOf(END, behaviorsOpen);
    if (begin >= 0 && end > begin && end < behaviorsClose) {
      managed = { start: begin, end: end + END.length };
    }
  }

  const repeat = { ...DEFAULT_REPEAT };
  if (managed) {
    const block = text.slice(managed.start, managed.end);
    repeat.tappingTermMs = readMs(block, "tapping-term-ms") ?? repeat.tappingTermMs;
    repeat.quickTapMs = readMs(block, "quick-tap-ms") ?? repeat.quickTapMs;
  }

  let ltOverride: ParsedKeymap["ltOverride"] = null;
  const lt = /&lt\s*\{([^{}]*)\}\s*;/.exec(code);
  if (lt) {
    const body = lt[1];
    ltOverride = {
      start: lt.index,
      end: lt.index + lt[0].length,
      quickTapMs: readMs(body, "quick-tap-ms"),
      tappingTermMs: readMs(body, "tapping-term-ms"),
    };
  }

  const keymapLineStart = text.lastIndexOf("\n", keymapOpen) + 1;
  return { layers, repeat, managed, behaviorsClose, keymapLineStart, keymapBody: { start: keymapOpen + 1, end: keymapClose }, ltOverride };
}

export function toKeymap(parsed: ParsedKeymap): Keymap {
  return {
    layers: parsed.layers.map(({ node, name, bindings }) => ({ node, name, bindings })),
    repeat: parsed.repeat,
  };
}

function formatRows(bindings: string[], rowLengths: number[], indent: string): string {
  const rows: string[][] = [];
  let i = 0;
  for (const len of rowLengths) {
    rows.push(bindings.slice(i, i + len));
    i += len;
  }
  if (i !== bindings.length) {
    throw new Error(`Expected ${i} bindings per layer, got ${bindings.length}`);
  }
  const widths: number[] = [];
  for (const row of rows) row.forEach((b, c) => (widths[c] = Math.max(widths[c] ?? 0, b.length)));
  const lines = rows.map((row) =>
    row
      .map((b, c) => (c === row.length - 1 ? b : b.padEnd(widths[c])))
      .join("  ")
      .trimEnd(),
  );
  return `\n${lines.join("\n")}\n${indent}`;
}

export function managedBlock(repeat: RepeatTiming, indent = "        "): string {
  const hold = (label: string, node: string, flavor: string, bindings: string) =>
    [
      `${label}: ${node} {`,
      `    compatible = "zmk,behavior-hold-tap";`,
      `    #binding-cells = <2>;`,
      `    flavor = "${flavor}";`,
      `    tapping-term-ms = <${repeat.tappingTermMs}>;`,
      `    quick-tap-ms = <${repeat.quickTapMs}>;`,
      `    bindings = ${bindings};`,
      `};`,
    ];
  return [
    BEGIN,
    "// Added by Tandem. Edits inside this block are overwritten.",
    "// Tap: key. Hold: layer or modifier. Tap, then hold: the key repeats.",
    ...hold("ltr", "layer_tap_repeat", "tap-preferred", "<&mo>, <&kp>"),
    ...hold("mtr", "mod_tap_repeat", "hold-preferred", "<&kp>, <&kp>"),
    END,
  ]
    .map((line, i) => (i === 0 ? line : indent + line))
    .join("\n");
}

interface Edit extends Span {
  text: string;
}

function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function indentBefore(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

export interface WriteOptions {
  /** Remove a global `&lt { ... };` override. Used once, on import. */
  dropLtOverride?: boolean;
}

const quoted = (name: string) => name.replace(/["\\]/g, "");

/** Span of a node plus the blank line before it, so removing it leaves no gap. */
function removalSpan(text: string, node: Span): Span {
  const prevLineStart = text.lastIndexOf("\n", node.start - 2) + 1;
  const blankBefore = node.start > 0 && /^[ \t]*\n$/.test(text.slice(prevLineStart, node.start));
  return { start: blankBefore ? prevLineStart : node.start, end: node.end };
}

/**
 * Edits for the layer nodes. Existing layers keep their place, removed layers
 * are cut out, and new layers go after the last one. New layers have to come
 * after every existing one, since layers are numbered by their order.
 */
function layerEdits(text: string, parsed: ParsedKeymap, keymap: Keymap, rowLengths: number[]): Edit[] {
  const edits: Edit[] = [];
  const kept = keymap.layers.filter((l) => parsed.layers.some((p) => p.node === l.node));
  const fileOrder = parsed.layers.filter((p) => kept.some((l) => l.node === p.node)).map((p) => p.node);
  if (kept.map((l) => l.node).join() !== fileOrder.join() || keymap.layers.slice(0, kept.length).some((l, i) => l !== kept[i])) {
    throw new Error("Layers can be added at the end or removed, but not reordered yet");
  }

  for (const p of parsed.layers) {
    if (!keymap.layers.some((l) => l.node === p.node)) edits.push({ ...removalSpan(text, p.nodeSpan), text: "" });
  }

  for (const layer of kept) {
    const target = parsed.layers.find((l) => l.node === layer.node)!;
    // Untouched layers keep their own spacing, such as Kinesis's gaps between halves.
    const same = layer.bindings.length === target.bindings.length && layer.bindings.every((b, i) => b === target.bindings[i]);
    if (!same) {
      const closingIndent = /[ \t]*$/.exec(text.slice(target.content.start, target.content.end))![0];
      edits.push({ ...target.content, text: formatRows(layer.bindings, rowLengths, closingIndent) });
    }
    if (layer.name !== target.name) {
      if (target.displayName) {
        edits.push({ ...target.displayName, text: quoted(layer.name) });
      } else {
        const indent = indentBefore(text, target.bindingsLine + 1);
        edits.push({ start: target.bindingsLine, end: target.bindingsLine, text: `${indent}display-name = "${quoted(layer.name)}";\n` });
      }
    }
  }

  const added = keymap.layers.slice(kept.length);
  if (added.length) {
    const last = parsed.layers[parsed.layers.length - 1];
    const indent = indentBefore(text, last.nodeSpan.start + 1);
    const inner = indent + "    ";
    const nodes = added.map((l) =>
      [
        "",
        `${indent}${l.node} {`,
        `${inner}display-name = "${quoted(l.name)}";`,
        `${inner}bindings = <${formatRows(l.bindings, rowLengths, inner)}>;`,
        `${indent}};`,
        "",
      ].join("\n"),
    );
    edits.push({ start: last.nodeSpan.end, end: last.nodeSpan.end, text: nodes.join("") });
  }
  return edits;
}

export function writeKeymap(text: string, keymap: Keymap, rowLengths: number[], options: WriteOptions = {}): string {
  const parsed = parseKeymap(text);
  const edits: Edit[] = layerEdits(text, parsed, keymap, rowLengths);

  if (parsed.managed) {
    const indent = indentBefore(text, parsed.managed.start);
    edits.push({ ...parsed.managed, text: managedBlock(keymap.repeat, indent) });
  } else if (parsed.behaviorsClose !== null) {
    const close = parsed.behaviorsClose;
    const closeIndent = indentBefore(text, close);
    const indent = closeIndent + "    ";
    const lineStart = text.lastIndexOf("\n", close - 1) + 1;
    edits.push({ start: lineStart, end: lineStart, text: `\n${indent}${managedBlock(keymap.repeat, indent)}\n` });
  } else {
    const at = parsed.keymapLineStart;
    const indent = indentBefore(text, at);
    const inner = indent + "    ";
    edits.push({
      start: at,
      end: at,
      text: `${indent}behaviors {\n${inner}${managedBlock(keymap.repeat, inner)}\n${indent}};\n\n`,
    });
  }

  if (options.dropLtOverride && parsed.ltOverride) {
    edits.push({ ...parsed.ltOverride, text: "" });
  }

  return applyEdits(text, edits);
}

/**
 * Takes ownership of a keymap the first time Tandem sees it. A global
 * `&lt { quick-tap-ms }` override makes every &lt key repeat on tap-then-hold,
 * which is what Tandem's &ltr does, so those keys become &ltr and the
 * override goes away. The keyboard behaves the same afterwards.
 */
export function importKeymap(text: string, rowLengths: number[]): { text: string; notes: string[] } {
  const parsed = parseKeymap(text);
  const keymap = toKeymap(parsed);
  const notes: string[] = [];

  const override = parsed.ltOverride;
  if (override?.quickTapMs !== undefined && !parsed.managed) {
    keymap.repeat = {
      quickTapMs: override.quickTapMs,
      tappingTermMs: override.tappingTermMs ?? DEFAULT_REPEAT.tappingTermMs,
    };
    let converted = 0;
    for (const layer of keymap.layers) {
      layer.bindings = layer.bindings.map((b) => {
        if (!/^&lt\s/.test(b)) return b;
        converted++;
        return b.replace(/^&lt\s/, "&ltr ");
      });
    }
    notes.push(
      `Converted ${converted} layer-tap key${converted === 1 ? "" : "s"} to "hold for layer, tap twice to repeat" (quick tap ${override.quickTapMs} ms).`,
    );
    return { text: writeKeymap(text, keymap, rowLengths, { dropLtOverride: true }), notes };
  }

  return { text: writeKeymap(text, keymap, rowLengths), notes };
}

/**
 * Replaces every layer with new ones, such as a layout read from a keyboard.
 * The rest of the file, including behaviors and macros, stays as it is.
 */
export function replaceLayers(text: string, layers: Omit<Layer, "node">[], rowLengths: number[]): string {
  const expected = rowLengths.reduce((a, b) => a + b, 0);
  for (const l of layers) {
    if (l.bindings.length !== expected) throw new Error(`Layer ${l.name} has ${l.bindings.length} keys, expected ${expected}`);
  }

  const parsed = parseKeymap(text);
  const closeIndent = indentBefore(text, parsed.keymapBody.end);
  const indent = closeIndent + "    ";
  const used = new Set<string>();
  const nodeName = (name: string, i: number) => {
    if (i === 0) return "default_layer";
    const base = `layer_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || i}`;
    let node = base;
    for (let n = 2; used.has(node); n++) node = `${base}_${n}`;
    used.add(node);
    return node;
  };

  const body = layers
    .map((l, i) =>
      [
        `${indent}${nodeName(l.name, i)} {`,
        `${indent}    display-name = "${l.name.replace(/["\\]/g, "")}";`,
        `${indent}    bindings = <${formatRows(l.bindings, rowLengths, indent + "    ")}>;`,
        `${indent}};`,
      ].join("\n"),
    )
    .join("\n\n");

  const content = `\n${indent}compatible = "zmk,keymap";\n\n${body}\n${closeIndent}`;
  return applyEdits(text, [{ ...parsed.keymapBody, text: content }]);
}

/**
 * Keys in `next` that do what the saved file already has keep the file's
 * spelling, so a key set back to what it was leaves its layer unchanged,
 * spacing and all.
 */
export function keepSpelling(saved: Keymap, next: Keymap): Keymap {
  const before = new Map(saved.layers.map((l) => [l.node, l]));
  return {
    ...next,
    layers: next.layers.map((layer) => {
      const old = before.get(layer.node);
      if (!old) return layer;
      return { ...layer, bindings: layer.bindings.map((b, i) => (old.bindings[i] !== undefined && sameBinding(b, old.bindings[i]) ? old.bindings[i] : b)) };
    }),
  };
}
