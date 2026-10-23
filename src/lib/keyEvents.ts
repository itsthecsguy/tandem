// Turns browser key presses into ZMK key codes. Uses KeyboardEvent.code, the
// physical key, because ZMK codes name physical keys too.

import { SHIFTED } from "../../shared/hid";

const CODES: Record<string, string> = {
  Minus: "MINUS",
  Equal: "EQUAL",
  BracketLeft: "LEFT_BRACKET",
  BracketRight: "RIGHT_BRACKET",
  Backslash: "BACKSLASH",
  Semicolon: "SEMICOLON",
  Quote: "SINGLE_QUOTE",
  Backquote: "GRAVE",
  Comma: "COMMA",
  Period: "PERIOD",
  Slash: "SLASH",
  Enter: "RETURN",
  Escape: "ESCAPE",
  Backspace: "BACKSPACE",
  Tab: "TAB",
  Space: "SPACE",
  Delete: "DELETE",
  Insert: "INSERT",
  CapsLock: "CAPSLOCK",
  ArrowUp: "UP_ARROW",
  ArrowDown: "DOWN_ARROW",
  ArrowLeft: "LEFT_ARROW",
  ArrowRight: "RIGHT_ARROW",
  Home: "HOME",
  End: "END",
  PageUp: "PAGE_UP",
  PageDown: "PAGE_DOWN",
  PrintScreen: "PRINTSCREEN",
  ScrollLock: "SCROLLLOCK",
  Pause: "PAUSE_BREAK",
  ContextMenu: "K_APPLICATION",
  ShiftLeft: "LEFT_SHIFT",
  ShiftRight: "RIGHT_SHIFT",
  ControlLeft: "LEFT_CONTROL",
  ControlRight: "RIGHT_CONTROL",
  AltLeft: "LEFT_ALT",
  AltRight: "RIGHT_ALT",
  MetaLeft: "LEFT_GUI",
  MetaRight: "RIGHT_GUI",
  NumLock: "KP_NUMLOCK",
  NumpadDivide: "KP_DIVIDE",
  NumpadMultiply: "KP_MULTIPLY",
  NumpadSubtract: "KP_MINUS",
  NumpadAdd: "KP_PLUS",
  NumpadEnter: "KP_ENTER",
  NumpadDecimal: "KP_DOT",
  NumpadEqual: "KP_EQUAL",
  AudioVolumeUp: "C_VOLUME_UP",
  AudioVolumeDown: "C_VOLUME_DOWN",
  AudioVolumeMute: "C_MUTE",
  MediaPlayPause: "C_PLAY_PAUSE",
  MediaTrackNext: "C_NEXT",
  MediaTrackPrevious: "C_PREVIOUS",
};


export const MODIFIER_EVENT_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/** The ZMK code for one physical key, without modifiers. */
export function zmkCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return `N${code.slice(5)}`;
  if (/^Numpad\d$/.test(code)) return `KP_N${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return CODES[code] ?? null;
}

/** The ZMK code for a key press with its modifiers, e.g. ⌘⇧\ -> LG(LS(BSLH)). */
export function zmkShortcut(e: Pick<KeyboardEvent, "code" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey">): string | null {
  const base = zmkCode(e.code);
  if (!base) return null;
  const onlyShift = e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey;
  if (onlyShift && SHIFTED[base]) return SHIFTED[base];
  const mods = [e.ctrlKey && "LC", e.altKey && "LA", e.shiftKey && "LS", e.metaKey && "LG"].filter(Boolean) as string[];
  return mods.reduceRight((inner, m) => `${m}(${inner})`, base);
}

/** Modifier symbols currently held, for showing a live preview. */
export function heldSymbols(e: Pick<KeyboardEvent, "metaKey" | "altKey" | "ctrlKey" | "shiftKey">): string {
  return [e.ctrlKey && "⌃", e.altKey && "⌥", e.shiftKey && "⇧", e.metaKey && "⌘"].filter(Boolean).join("");
}
