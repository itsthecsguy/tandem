// USB HID usages and the ZMK key names for them. ZMK Studio reports key
// bindings as encoded usages: modifiers << 24 | page << 16 | id.

const KEYBOARD: Record<number, string> = {
  0x28: "RETURN",
  0x29: "ESCAPE",
  0x2a: "BACKSPACE",
  0x2b: "TAB",
  0x2c: "SPACE",
  0x2d: "MINUS",
  0x2e: "EQUAL",
  0x2f: "LEFT_BRACKET",
  0x30: "RIGHT_BRACKET",
  0x31: "BACKSLASH",
  0x32: "NON_US_HASH",
  0x33: "SEMICOLON",
  0x34: "SINGLE_QUOTE",
  0x35: "GRAVE",
  0x36: "COMMA",
  0x37: "PERIOD",
  0x38: "SLASH",
  0x39: "CAPSLOCK",
  0x46: "PRINTSCREEN",
  0x47: "SCROLLLOCK",
  0x48: "PAUSE_BREAK",
  0x49: "INSERT",
  0x4a: "HOME",
  0x4b: "PAGE_UP",
  0x4c: "DELETE",
  0x4d: "END",
  0x4e: "PAGE_DOWN",
  0x4f: "RIGHT_ARROW",
  0x50: "LEFT_ARROW",
  0x51: "DOWN_ARROW",
  0x52: "UP_ARROW",
  0x53: "KP_NUMLOCK",
  0x54: "KP_DIVIDE",
  0x55: "KP_MULTIPLY",
  0x56: "KP_MINUS",
  0x57: "KP_PLUS",
  0x58: "KP_ENTER",
  0x62: "KP_N0",
  0x63: "KP_DOT",
  0x64: "NON_US_BACKSLASH",
  0x65: "K_APPLICATION",
  0x67: "KP_EQUAL",
  0x7f: "K_MUTE",
  0x80: "K_VOLUME_UP",
  0x81: "K_VOLUME_DOWN",
  0xe0: "LEFT_CONTROL",
  0xe1: "LEFT_SHIFT",
  0xe2: "LEFT_ALT",
  0xe3: "LEFT_GUI",
  0xe4: "RIGHT_CONTROL",
  0xe5: "RIGHT_SHIFT",
  0xe6: "RIGHT_ALT",
  0xe7: "RIGHT_GUI",
};
for (let i = 0; i < 26; i++) KEYBOARD[0x04 + i] = String.fromCharCode(65 + i);
for (let i = 1; i <= 9; i++) KEYBOARD[0x1d + i] = `N${i}`;
KEYBOARD[0x27] = "N0";
for (let i = 1; i <= 12; i++) KEYBOARD[0x39 + i] = `F${i}`;
for (let i = 13; i <= 24; i++) KEYBOARD[0x68 + i - 13] = `F${i}`;
for (let i = 1; i <= 9; i++) KEYBOARD[0x58 + i] = `KP_N${i}`;

const CONSUMER: Record<number, string> = {
  0x6f: "C_BRIGHTNESS_INC",
  0x70: "C_BRIGHTNESS_DEC",
  0xb5: "C_NEXT",
  0xb6: "C_PREVIOUS",
  0xb7: "C_STOP",
  0xcd: "C_PLAY_PAUSE",
  0xe2: "C_MUTE",
  0xe9: "C_VOLUME_UP",
  0xea: "C_VOLUME_DOWN",
};

// Shift plus these keys has its own ZMK name, which reads better than LS(...).
export const SHIFTED: Record<string, string> = {
  N1: "EXCLAMATION",
  N2: "AT_SIGN",
  N3: "HASH",
  N4: "DOLLAR",
  N5: "PERCENT",
  N6: "CARET",
  N7: "AMPERSAND",
  N8: "ASTERISK",
  N9: "LEFT_PARENTHESIS",
  N0: "RIGHT_PARENTHESIS",
  MINUS: "UNDERSCORE",
  EQUAL: "PLUS",
  LEFT_BRACKET: "LEFT_BRACE",
  RIGHT_BRACKET: "RIGHT_BRACE",
  BACKSLASH: "PIPE",
  SEMICOLON: "COLON",
  SINGLE_QUOTE: "DOUBLE_QUOTES",
  GRAVE: "TILDE",
  COMMA: "LESS_THAN",
  PERIOD: "GREATER_THAN",
  SLASH: "QUESTION",
};

// Implicit modifier bits, outermost first in ZMK's LC(LS(...)) order.
const MOD_BITS: [number, string][] = [
  [0x01, "LC"],
  [0x10, "RC"],
  [0x04, "LA"],
  [0x40, "RA"],
  [0x02, "LS"],
  [0x20, "RS"],
  [0x08, "LG"],
  [0x80, "RG"],
];

/** The ZMK name for an encoded HID usage, e.g. 0x02070004 -> "LS(A)". Null if unknown. */
export function usageToCode(usage: number): string | null {
  const mods = (usage >>> 24) & 0xff;
  const page = (usage >>> 16) & 0xff;
  const id = usage & 0xffff;
  const base = page === 0x07 ? KEYBOARD[id] : page === 0x0c ? CONSUMER[id] : undefined;
  if (!base) return null;
  if (mods === 0x02 && SHIFTED[base]) return SHIFTED[base];
  return MOD_BITS.filter(([bit]) => mods & bit)
    .map(([, fn]) => fn)
    .reduceRight((inner, fn) => `${fn}(${inner})`, base);
}
