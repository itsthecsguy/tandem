// Labels shrink to fit their keycap. These are rough widths for the system
// font in em units: close enough to keep text inside its box.

const SYMBOLS = /[⌘⇧⌥⌃⌫↑↓←→⏯⏭⏮▽]/;

export function labelEm(label: string): number {
  let em = 0;
  for (const ch of label) {
    if (SYMBOLS.test(ch)) em += 0.95;
    else if (/[A-Z0-9]/.test(ch)) em += 0.64;
    else if (/[a-z]/.test(ch)) em += 0.53;
    else if (/\s/.test(ch)) em += 0.28;
    else em += 0.6;
  }
  return em;
}

/** The largest font size up to `base` at which `label` fits in `maxWidth` pixels. */
export function fitFont(label: string, base: number, maxWidth: number, min = 6.5): number {
  const em = labelEm(label);
  if (!em) return base;
  return Math.max(min, Math.min(base, maxWidth / em));
}
