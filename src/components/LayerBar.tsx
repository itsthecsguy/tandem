import { Plus } from "lucide-react";
import type { CSSProperties } from "react";

import type { Keymap } from "../../shared/types";
import { type Activator, ACTIVATOR_VERB, activatorSummary, layerColor } from "../lib/layers";

interface Props {
  keymap: Keymap;
  activators: Activator[][];
  active: number;
  /** Unsaved changes per layer. */
  changes: number[];
  onSelect: (layer: number) => void;
  onHover: (layer: number | null) => void;
  /** Adds a layer. Missing when no more layers fit. */
  onAdd?: () => void;
}

function tooltip(name: string, list: Activator[], layerNames: string[]): string {
  if (!list.length) return `${name}: no key turns this layer on yet`;
  return [
    name,
    ...list.map((a) => `${ACTIVATOR_VERB[a.kind]} ${a.label}${a.from ? ` (on ${layerNames[a.from]})` : ""}`),
  ].join("\n");
}

export function LayerBar({ keymap, activators, active, changes, onSelect, onHover, onAdd }: Props) {
  const names = keymap.layers.map((l) => l.name);
  return (
    <nav className="layer-bar" aria-label="Layers" onMouseLeave={() => onHover(null)}>
      {keymap.layers.map((layer, i) => {
        const summary = activatorSummary(activators[i]);
        const color = layerColor(i);
        return (
          <button
            key={layer.node}
            type="button"
            className={`layer-tab${i === active ? " is-on" : ""}`}
            style={{ "--layer": color ?? "var(--text-3)" } as CSSProperties}
            aria-pressed={i === active}
            title={i === 0 ? `${layer.name}: always on` : tooltip(layer.name, activators[i], names)}
            onClick={() => onSelect(i)}
            onMouseEnter={() => onHover(i)}
            onFocus={() => onHover(i)}
            onBlur={() => onHover(null)}
          >
            <span className="layer-tab__name">
              <span className="layer-tab__dot" />
              {layer.name}
              {changes[i] > 0 && <span className="layer-tab__changed" aria-label={`${changes[i]} unsaved`} />}
            </span>
            <span className="layer-tab__how">
              {i === 0 ? (
                "Always on"
              ) : summary ? (
                <>
                  {summary.verb}
                  {summary.keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </>
              ) : (
                <span className="layer-tab__none">No key yet</span>
              )}
            </span>
          </button>
        );
      })}
      <button type="button" className="layer-bar__add" onClick={onAdd} disabled={!onAdd} title="Add a layer" aria-label="Add a layer">
        <Plus size={16} />
      </button>
    </nav>
  );
}
