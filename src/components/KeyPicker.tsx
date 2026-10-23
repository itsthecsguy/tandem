import { ChevronDown, Keyboard as KeyboardIcon, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { KEYCODES, type KeyGroup, findKey, keyLabel, keyName, sameKey } from "../../shared/keycodes";
import { MODIFIER_EVENT_CODES, heldSymbols, zmkCode, zmkShortcut } from "../lib/keyEvents";

const WRAPPERS = [
  { fn: "LC", symbol: "⌃", name: "Control" },
  { fn: "LA", symbol: "⌥", name: "Option" },
  { fn: "LS", symbol: "⇧", name: "Shift" },
  { fn: "LG", symbol: "⌘", name: "Command" },
];

// "LG(LS(BSLH))" -> { mods: ["LG", "LS"], base: "BSLH" }
function unwrap(code: string): { mods: string[]; base: string } {
  const mods: string[] = [];
  let base = code.trim();
  for (;;) {
    const m = /^(LC|LS|LA|LG|RC|RS|RA|RG)\((.*)\)$/.exec(base);
    if (!m) break;
    mods.push(m[1]);
    base = m[2];
  }
  return { mods, base };
}

function wrap(mods: string[], base: string): string {
  const order = WRAPPERS.map((w) => w.fn);
  return [...mods]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .reduceRight((inner, m) => `${m}(${inner})`, base);
}

type Mode = "pick" | "press";

/** Listens for one key or shortcut on the keyboard. */
function Recorder({ plain, onDone, onCancel }: { plain?: boolean; onDone: (code: string) => void; onCancel: () => void }) {
  const [held, setHeld] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // Kept in refs so re-rendering while keys are held doesn't reset the listener.
  const done = useRef(onDone);
  const cancel = useRef(onCancel);
  done.current = onDone;
  cancel.current = onCancel;

  useEffect(() => {
    // A modifier pressed and released on its own records that modifier.
    let loneModifier: string | null = null;
    const onDone = (code: string) => done.current(code);

    const down = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        cancel.current();
        return;
      }
      setHeld(heldSymbols(e));
      if (MODIFIER_EVENT_CODES.has(e.code)) {
        loneModifier = e.code;
        return;
      }
      loneModifier = null;
      if (plain) {
        setNote("This field takes a modifier. Press Shift, Control, Option or Command on its own.");
        return;
      }
      const code = zmkShortcut(e);
      if (code) onDone(code);
      else setNote(`Tandem doesn't know the key "${e.code}". Pick it from the list instead.`);
    };

    const up = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setHeld(heldSymbols(e));
      if (loneModifier === e.code) {
        const code = zmkCode(e.code);
        if (code) onDone(code);
      }
      loneModifier = null;
    };

    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [plain]);

  return (
    <div className="recorder" aria-live="polite">
      <div className={`recorder__keys${held ? " is-held" : ""}`}>{held || <span className="recorder__pulse" />}</div>
      <p className="recorder__title">{plain ? "Press a modifier key" : "Press a key or shortcut"}</p>
      <p className="hint">
        {note ??
          (plain
            ? "Use the keyboard you're editing or any other one."
            : "Hold modifiers, then press the key. macOS keeps a few shortcuts, like ⌘Q and ⌘Tab, for itself.")}
      </p>
      <p className="hint">Esc cancels.</p>
    </div>
  );
}

interface Props {
  value: string;
  onChange: (code: string) => void;
  label?: string;
  /** Hide the shortcut modifiers, e.g. when picking a hold modifier. */
  plain?: boolean;
  groups?: KeyGroup[];
}

export function KeyPicker({ value, onChange, label, plain, groups }: Props) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const { mods, base } = unwrap(value);
  const open = mode !== null;

  useEffect(() => {
    if (!open) return;
    popover.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setMode(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setMode(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = groups ? KEYCODES.filter((k) => groups.includes(k.group)) : KEYCODES;
    if (!q) return pool;
    return pool.filter(
      (k) =>
        k.name.toLowerCase().includes(q) ||
        k.code.toLowerCase().includes(q) ||
        k.label.toLowerCase() === q ||
        k.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }, [query, groups]);

  const grouped = useMemo(() => {
    const map = new Map<KeyGroup, typeof filtered>();
    for (const k of filtered) map.set(k.group, [...(map.get(k.group) ?? []), k]);
    return [...map.entries()];
  }, [filtered]);

  const finish = (code: string) => {
    onChange(code);
    setMode(null);
    setQuery("");
  };
  const pick = (code: string) => finish(plain ? code : wrap(mods, code));

  const typed = query.trim().toUpperCase().replace(/\s+/g, "_");
  const canUseTyped = !filtered.length && typed && !findKey(typed) && /^[A-Z0-9_()]+$/.test(typed);

  return (
    <div className="picker" ref={root}>
      {label && <span className="field__label">{label}</span>}
      <div className="picker__row">
        <button type="button" className="picker__button" onClick={() => setMode((m) => (m ? null : "pick"))} aria-expanded={open}>
          <span className="picker__cap">{keyLabel(value)}</span>
          <span className="picker__name">{keyName(value)}</span>
          <ChevronDown size={15} className="picker__chevron" />
        </button>
        <button
          type="button"
          className={`picker__record${mode === "press" ? " is-on" : ""}`}
          onClick={() => setMode((m) => (m === "press" ? null : "press"))}
          title="Press keys to set this"
          aria-label="Press keys to set this"
        >
          <KeyboardIcon size={16} />
        </button>
      </div>

      {open && (
        <div className="picker__popover" ref={popover} role="dialog" aria-label="Choose a key">
          <div className="picker__modes segmented">
            <button type="button" className={mode === "pick" ? "is-on" : ""} onClick={() => setMode("pick")}>
              Pick
            </button>
            <button type="button" className={mode === "press" ? "is-on" : ""} onClick={() => setMode("press")}>
              Press keys
            </button>
          </div>

          {mode === "press" ? (
            <Recorder plain={plain} onDone={finish} onCancel={() => setMode("pick")} />
          ) : (
            <>
              <div className="picker__search">
                <Search size={15} />
                <input
                  autoFocus
                  placeholder="Search keys"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && filtered[0]) pick(filtered[0].code);
                  }}
                />
              </div>

              {!plain && (
                <div className="picker__mods">
                  <span>With</span>
                  {WRAPPERS.map((w) => {
                    const on = mods.includes(w.fn);
                    return (
                      <button
                        key={w.fn}
                        type="button"
                        className={`chip${on ? " chip--on" : ""}`}
                        title={w.name}
                        aria-pressed={on}
                        onClick={() => onChange(wrap(on ? mods.filter((m) => m !== w.fn) : [...mods, w.fn], base))}
                      >
                        {w.symbol}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="picker__list">
                {grouped.map(([group, keys]) => (
                  <section key={group}>
                    <h4>{group}</h4>
                    <div className="picker__grid">
                      {keys.map((k) => (
                        <button
                          key={k.code}
                          type="button"
                          className={`picker__key${sameKey(k.code, base) ? " picker__key--on" : ""}`}
                          title={`${k.name} (${k.code})`}
                          onClick={() => pick(k.code)}
                        >
                          {k.label}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
                {canUseTyped && (
                  <button type="button" className="picker__typed" onClick={() => pick(typed)}>
                    Use key code <code>{typed}</code>
                  </button>
                )}
                {!grouped.length && !canUseTyped && <p className="picker__empty">No keys match.</p>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
