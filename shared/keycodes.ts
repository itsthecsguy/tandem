// ZMK key codes the editor knows by name. Anything else still works: it's
// shown and saved as typed.

export type KeyGroup =
  | "Letters"
  | "Numbers"
  | "Symbols"
  | "Editing"
  | "Navigation"
  | "Modifiers"
  | "Function"
  | "Media"
  | "Keypad";

export interface KeyCode {
  code: string;
  label: string;
  name: string;
  group: KeyGroup;
  aliases: string[];
}

type Row = [code: string, label: string, name: string, ...aliases: string[]];

const table: Record<KeyGroup, Row[]> = {
  Letters: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => [c, c, c] as Row),
  Numbers: "1234567890".split("").map((n) => [`N${n}`, n, n, `NUMBER_${n}`] as Row),
  Symbols: [
    ["EXCLAMATION", "!", "Exclamation", "EXCL"],
    ["AT_SIGN", "@", "At", "AT", "ATSN"],
    ["HASH", "#", "Hash", "POUND"],
    ["DOLLAR", "$", "Dollar", "DLLR"],
    ["PERCENT", "%", "Percent", "PRCNT"],
    ["CARET", "^", "Caret"],
    ["AMPERSAND", "&", "Ampersand", "AMPS"],
    ["ASTERISK", "*", "Asterisk", "ASTRK", "STAR"],
    ["LEFT_PARENTHESIS", "(", "Left paren", "LPAR"],
    ["RIGHT_PARENTHESIS", ")", "Right paren", "RPAR"],
    ["MINUS", "-", "Minus"],
    ["UNDERSCORE", "_", "Underscore", "UNDER"],
    ["EQUAL", "=", "Equal"],
    ["PLUS", "+", "Plus"],
    ["LEFT_BRACKET", "[", "Left bracket", "LBKT"],
    ["RIGHT_BRACKET", "]", "Right bracket", "RBKT"],
    ["LEFT_BRACE", "{", "Left brace", "LBRC"],
    ["RIGHT_BRACE", "}", "Right brace", "RBRC"],
    ["BACKSLASH", "\\", "Backslash", "BSLH"],
    ["PIPE", "|", "Pipe"],
    ["SEMICOLON", ";", "Semicolon", "SEMI"],
    ["COLON", ":", "Colon"],
    ["SINGLE_QUOTE", "'", "Quote", "SQT", "APOSTROPHE", "APOS"],
    ["DOUBLE_QUOTES", '"', "Double quote", "DQT"],
    ["GRAVE", "`", "Grave"],
    ["TILDE", "~", "Tilde"],
    ["COMMA", ",", "Comma"],
    ["LESS_THAN", "<", "Less than", "LT"],
    ["PERIOD", ".", "Period", "DOT"],
    ["GREATER_THAN", ">", "Greater than", "GT"],
    ["SLASH", "/", "Slash", "FSLH"],
    ["QUESTION", "?", "Question mark", "QMARK"],
  ],
  Editing: [
    ["RETURN", "Enter", "Enter", "ENTER", "RET"],
    ["ESCAPE", "Esc", "Escape", "ESC"],
    ["BACKSPACE", "⌫", "Backspace", "BSPC"],
    ["DELETE", "Del", "Delete", "DEL"],
    ["TAB", "Tab", "Tab"],
    ["SPACE", "Space", "Space", "SPC"],
    ["INSERT", "Ins", "Insert", "INS"],
    ["CAPSLOCK", "Caps", "Caps Lock", "CAPS", "CLCK"],
    ["PRINTSCREEN", "PrtSc", "Print Screen", "PSCRN"],
    ["SCROLLLOCK", "ScrLk", "Scroll Lock", "SLCK"],
    ["PAUSE_BREAK", "Pause", "Pause", "PAUSE"],
    ["K_APPLICATION", "Menu", "Menu", "K_APP", "K_CONTEXT_MENU", "K_CMENU"],
  ],
  Navigation: [
    ["UP_ARROW", "↑", "Up", "UP"],
    ["DOWN_ARROW", "↓", "Down", "DOWN"],
    ["LEFT_ARROW", "←", "Left", "LEFT"],
    ["RIGHT_ARROW", "→", "Right", "RIGHT"],
    ["HOME", "Home", "Home"],
    ["END", "End", "End"],
    ["PAGE_UP", "PgUp", "Page Up", "PG_UP"],
    ["PAGE_DOWN", "PgDn", "Page Down", "PG_DN"],
  ],
  Modifiers: [
    ["LEFT_SHIFT", "⇧", "Left Shift", "LSHIFT", "LSHFT"],
    ["LEFT_CONTROL", "⌃", "Left Control", "LCTRL", "LCTL"],
    ["LEFT_ALT", "⌥", "Left Option", "LALT", "LEFT_OPTION", "LOPT"],
    ["LEFT_GUI", "⌘", "Left Command", "LGUI", "LCMD", "LEFT_COMMAND", "LMETA", "LEFT_META", "LWIN", "LEFT_WIN"],
    ["RIGHT_SHIFT", "⇧", "Right Shift", "RSHIFT", "RSHFT"],
    ["RIGHT_CONTROL", "⌃", "Right Control", "RCTRL", "RCTL"],
    ["RIGHT_ALT", "⌥", "Right Option", "RALT", "RIGHT_OPTION", "ROPT"],
    ["RIGHT_GUI", "⌘", "Right Command", "RGUI", "RCMD", "RIGHT_COMMAND", "RMETA", "RIGHT_META", "RWIN", "RIGHT_WIN"],
  ],
  Function: Array.from({ length: 24 }, (_, i) => [`F${i + 1}`, `F${i + 1}`, `F${i + 1}`] as Row),
  Media: [
    ["C_VOLUME_UP", "Vol+", "Volume up", "C_VOL_UP"],
    ["C_VOLUME_DOWN", "Vol−", "Volume down", "C_VOL_DN"],
    ["C_MUTE", "Mute", "Mute"],
    ["K_MUTE", "Mute", "Mute (keyboard)"],
    ["C_PLAY_PAUSE", "⏯", "Play / pause", "C_PP"],
    ["C_NEXT", "⏭", "Next track"],
    ["C_PREVIOUS", "⏮", "Previous track", "C_PREV"],
    ["C_BRIGHTNESS_INC", "Bri+", "Brightness up", "C_BRI_UP", "C_BRI_INC"],
    ["C_BRIGHTNESS_DEC", "Bri−", "Brightness down", "C_BRI_DN", "C_BRI_DEC"],
  ],
  Keypad: [
    ["KP_NUMLOCK", "Num", "Num Lock", "KP_NUM", "KP_NLCK"],
    ["KP_DIVIDE", "/", "Keypad /", "KP_SLASH"],
    ["KP_MULTIPLY", "*", "Keypad *", "KP_ASTERISK"],
    ["KP_MINUS", "-", "Keypad -", "KP_SUBTRACT"],
    ["KP_PLUS", "+", "Keypad +"],
    ["KP_ENTER", "Enter", "Keypad Enter"],
    ["KP_DOT", ".", "Keypad .", "KP_DOT"],
    ["KP_EQUAL", "=", "Keypad ="],
    ...("1234567890".split("").map((n) => [`KP_N${n}`, n, `Keypad ${n}`, `KP_NUMBER_${n}`] as Row)),
  ],
};

export const KEYCODES: KeyCode[] = (Object.keys(table) as KeyGroup[]).flatMap((group) =>
  table[group].map(([code, label, name, ...aliases]) => ({ code, label, name, group, aliases })),
);

const byName = new Map<string, KeyCode>();
for (const k of KEYCODES) {
  byName.set(k.code, k);
  for (const a of k.aliases) byName.set(a, k);
}

// Modifier functions like LG(LS(BSLH)): Command+Shift+Backslash.
const MOD_FUNCS: Record<string, string> = {
  LC: "⌃", LCTRL: "⌃", LEFT_CONTROL: "⌃",
  LS: "⇧", LSHFT: "⇧", LEFT_SHIFT: "⇧",
  LA: "⌥", LALT: "⌥", LEFT_ALT: "⌥",
  LG: "⌘", LGUI: "⌘", LEFT_GUI: "⌘", LEFT_COMMAND: "⌘",
  RC: "⌃", RCTRL: "⌃", RIGHT_CONTROL: "⌃",
  RS: "⇧", RSHFT: "⇧", RIGHT_SHIFT: "⇧",
  RA: "⌥", RALT: "⌥", RIGHT_ALT: "⌥",
  RG: "⌘", RGUI: "⌘", RIGHT_GUI: "⌘", RIGHT_COMMAND: "⌘",
};

export const MODIFIER_CODES = ["LEFT_SHIFT", "LEFT_CONTROL", "LEFT_ALT", "LEFT_GUI", "RIGHT_SHIFT", "RIGHT_CONTROL", "RIGHT_ALT", "RIGHT_GUI"];

export function findKey(code: string): KeyCode | undefined {
  return byName.get(code.trim());
}

/** Short label for a key code, e.g. "BSPC" -> "⌫", "LG(LS(BSLH))" -> "⌘⇧\". */
export function keyLabel(code: string): string {
  const trimmed = code.trim();
  const wrapped = /^([A-Z_]+)\((.*)\)$/.exec(trimmed);
  if (wrapped && MOD_FUNCS[wrapped[1]]) {
    return MOD_FUNCS[wrapped[1]] + keyLabel(wrapped[2]);
  }
  const known = byName.get(trimmed);
  if (known) return known.label;
  return trimmed.replace(/^(KP_|C_|K_)/, "").replace(/_/g, " ");
}

/** Longer name for a key code, used in the inspector. */
export function keyName(code: string): string {
  const trimmed = code.trim();
  const wrapped = /^([A-Z_]+)\((.*)\)$/.exec(trimmed);
  if (wrapped && MOD_FUNCS[wrapped[1]]) {
    return `${MOD_FUNCS[wrapped[1]]} ${keyName(wrapped[2])}`;
  }
  return byName.get(trimmed)?.name ?? trimmed;
}

/** True when two codes name the same key, e.g. "BSPC" and "BACKSPACE". */
export function sameKey(a: string, b: string): boolean {
  const ka = byName.get(a.trim());
  const kb = byName.get(b.trim());
  return ka && kb ? ka === kb : a.trim() === b.trim();
}
