import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type ThemeChoice, useTheme } from "../lib/theme";

const OPTIONS: { id: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { id: "system", label: "Match system", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

export function ThemeMenu() {
  const [choice, setChoice] = useTheme();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = OPTIONS.find((o) => o.id === choice)!;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="theme-menu" ref={root}>
      <button
        type="button"
        className="btn btn--ghost btn--icon"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Appearance: ${current.label}`}
        title="Appearance"
      >
        <current.icon size={16} />
      </button>
      {open && (
        <div className="menu menu--right" role="menu">
          <div className="menu__head">Appearance</div>
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitemradio"
              aria-checked={o.id === choice}
              className={`menu__item${o.id === choice ? " is-on" : ""}`}
              onClick={() => {
                setChoice(o.id);
                setOpen(false);
              }}
            >
              <o.icon size={15} /> {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
