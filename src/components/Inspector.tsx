import { Keyboard as KeyboardIcon, Plus, Trash2 } from "lucide-react";
import { type CSSProperties, useState } from "react";

import {
  BEHAVIORS,
  type Binding,
  type BindingKind,
  convertBinding,
  formatBinding,
  keyFace,
  parseBinding,
  targetLayer,
} from "../../shared/bindings";
import { keyLabel, keyName } from "../../shared/keycodes";
import { layerReferences } from "../../shared/layers";
import type { AppState, BuildSettings, Keymap, LayoutKey, RepeatTiming } from "../../shared/types";
import { keyDescription } from "../lib/guide";
import { type Activator, ACTIVATOR_VERB, layerColor } from "../lib/layers";
import { fitFont } from "../lib/text";
import { GitHubMark } from "./GitHubMark";
import { KeyPicker } from "./KeyPicker";

const GROUPS: { id: string; label: string; kinds: BindingKind[] }[] = [
  { id: "key", label: "Key", kinds: ["kp"] },
  { id: "hold", label: "Tap + hold", kinds: ["ltr", "mtr", "lt", "mt"] },
  { id: "layer", label: "Layer", kinds: ["mo", "tog", "to"] },
  { id: "other", label: "Other", kinds: ["trans", "none", "raw"] },
];

function LayerChoice({ value, layerNames, onChange, label }: { value: number; layerNames: string[]; onChange: (n: number) => void; label: string }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="layer-choice">
        {layerNames.map((name, i) => (
          <button
            key={i}
            type="button"
            className={i === value ? "is-on" : ""}
            style={{ "--layer": layerColor(i) ?? "var(--text-3)" } as CSSProperties}
            aria-pressed={i === value}
            onClick={() => onChange(i)}
          >
            <span className="layer-tab__dot" />
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span className="slider__top">
        <span>{label}</span>
        <span className="slider__value">{value} ms</span>
      </span>
      <input type="range" min={100} max={400} step={10} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

/** A tiny press timeline: short bars are taps, long bars are holds. */
function Gesture({ presses }: { presses: ("tap" | "hold")[] }) {
  let x = 0;
  return (
    <svg className="gesture" width="46" height="10" viewBox="0 0 46 10" aria-hidden>
      {presses.map((p, i) => {
        const w = p === "tap" ? 8 : 22;
        const bar = <rect key={i} x={x} y={2} width={w} height={6} rx={3} />;
        x += w + 5;
        return bar;
      })}
    </svg>
  );
}

function title(b: Binding, layerNames: string[]): string {
  if ("key" in b) return keyName(b.key);
  if (b.kind === "trans") return "Transparent";
  if (b.kind === "none") return "Empty key";
  const face = keyFace(b, layerNames);
  return face.tap ? `${face.tap} key` : "Empty key";
}

interface KeyProps {
  layoutKey: LayoutKey;
  layerIndex: number;
  layerNames: string[];
  binding: string;
  /** The base layer's binding here, which a transparent key falls through to. */
  fallback?: string;
  repeat: RepeatTiming;
  onChange: (binding: string) => void;
  onRepeatChange: (repeat: RepeatTiming) => void;
}

export function KeyInspector({ layoutKey, layerIndex, layerNames, binding, fallback, repeat, onChange, onRepeatChange }: KeyProps) {
  const b = parseBinding(binding);
  const through = b.kind === "trans" && fallback ? keyFace(parseBinding(fallback), layerNames) : null;
  const face = through ?? keyFace(b, layerNames);
  const set = (next: Binding) => onChange(formatBinding(next));
  const choose = (kind: BindingKind) => set(convertBinding(b, kind, layerIndex === 0 ? 1 : layerIndex));
  const group = GROUPS.find((g) => g.kinds.includes(b.kind)) ?? GROUPS[0];
  const target = targetLayer(b);
  const holdColor = target !== null ? layerColor(target) : undefined;

  return (
    <div className="inspector__body">
      <header className="inspector__head">
        <div className={`cap-preview${through ? " cap-preview--through" : ""}`} style={{ "--layer": holdColor } as CSSProperties}>
          <span className="cap-preview__tap" style={{ fontSize: fitFont(face.tap || "·", 18, 42) }}>
            {face.tap || "·"}
          </span>
          {face.hold && (
            <span className="cap-preview__hold" style={{ fontSize: fitFont(face.hold, 10, 44) }}>
              {face.hold}
            </span>
          )}
          {face.repeat && <span className="cap-preview__repeat">2×</span>}
        </div>
        <div>
          <span className="eyebrow">
            {keyDescription(layoutKey)} · {layerNames[layerIndex]}
          </span>
          <h2>{title(b, layerNames)}</h2>
          {through && (
            <span className="eyebrow">
              Uses {through.tap || "nothing"} from {layerNames[0]}
            </span>
          )}
        </div>
      </header>

      <section className="inspector__section">
        <div className="segmented segmented--full" role="tablist" aria-label="Kind of key">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={g.id === group.id}
              className={g.id === group.id ? "is-on" : ""}
              onClick={() => g.id !== group.id && choose(g.kinds[0])}
            >
              {g.label}
            </button>
          ))}
        </div>

        {group.kinds.length > 1 && (
          <div className="choices">
            {group.kinds.map((kind) => {
              const info = BEHAVIORS.find((x) => x.kind === kind)!;
              const on = kind === b.kind;
              return (
                <button key={kind} type="button" className={`choice${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => choose(kind)}>
                  <span className="choice__dot" />
                  <span className="choice__text">
                    <span className="choice__title">
                      {info.title}
                      {info.featured && <span className="tag">Tandem</span>}
                    </span>
                    {on && <span className="choice__desc">{info.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {group.kinds.length === 1 && <p className="hint hint--spaced">{BEHAVIORS.find((x) => x.kind === b.kind)?.description}</p>}
      </section>

      <section className="inspector__section inspector__fields">
        {b.kind === "kp" && <KeyPicker label="Key" value={b.key} onChange={(key) => set({ ...b, key })} />}

        {(b.kind === "ltr" || b.kind === "lt") && (
          <>
            <KeyPicker label="Tap" value={b.key} onChange={(key) => set({ ...b, key })} />
            <LayerChoice label="Hold" value={b.layer} layerNames={layerNames} onChange={(layer) => set({ ...b, layer })} />
          </>
        )}

        {(b.kind === "mtr" || b.kind === "mt") && (
          <>
            <KeyPicker label="Tap" value={b.key} onChange={(key) => set({ ...b, key })} />
            <KeyPicker label="Hold" plain groups={["Modifiers"]} value={b.mod} onChange={(mod) => set({ ...b, mod })} />
          </>
        )}

        {(b.kind === "mo" || b.kind === "tog" || b.kind === "to") && (
          <LayerChoice label="Layer" value={b.layer} layerNames={layerNames} onChange={(layer) => set({ ...b, layer })} />
        )}

        {b.kind === "raw" && (
          <label className="field">
            <span className="field__label">ZMK binding</span>
            <input className="input input--mono" value={b.text} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
          </label>
        )}
      </section>

      {(b.kind === "ltr" || b.kind === "mtr" || b.kind === "lt" || b.kind === "mt") && (
        <section className="inspector__section">
          <span className="section-label">How it works</span>
          <dl className="howto">
            <div>
              <dt>
                <Gesture presses={["tap"]} /> Tap
              </dt>
              <dd>{keyLabel(b.key)}</dd>
            </div>
            <div>
              <dt>
                <Gesture presses={["hold"]} /> Hold
              </dt>
              <dd style={holdColor ? { color: holdColor } : undefined}>
                {b.kind === "ltr" || b.kind === "lt" ? (layerNames[b.layer] ?? `Layer ${b.layer}`) : keyName(b.mod)}
              </dd>
            </div>
            {(b.kind === "ltr" || b.kind === "mtr") && (
              <div>
                <dt>
                  <Gesture presses={["tap", "hold"]} /> Tap, then hold
                </dt>
                <dd>{keyLabel(b.key)} repeats</dd>
              </div>
            )}
          </dl>
          {(b.kind === "ltr" || b.kind === "mtr") && (
            <div className="timing">
              <Slider label="Counts as a hold after" value={repeat.tappingTermMs} onChange={(tappingTermMs) => onRepeatChange({ ...repeat, tappingTermMs })} />
              <Slider label="Second press within" value={repeat.quickTapMs} onChange={(quickTapMs) => onRepeatChange({ ...repeat, quickTapMs })} />
              <p className="hint">Timing applies to every key that uses Tandem's repeat behaviors.</p>
            </div>
          )}
        </section>
      )}

      <footer className="inspector__foot">
        <code>{binding}</code>
      </footer>
    </div>
  );
}

/** Name and delete controls for the layer being viewed. */
function LayerSettings({ keymap, layer, onRename, onRemove }: { keymap: Keymap; layer: number; onRename: (i: number, name: string) => void; onRemove: (i: number) => void }) {
  const [confirming, setConfirming] = useState(false);
  const current = keymap.layers[layer];
  const references = layerReferences(keymap, layer);
  const later = keymap.layers.length - 1 - layer;

  return (
    <section className="inspector__section layer-settings" style={{ "--layer": layerColor(layer) ?? "var(--text-3)" } as CSSProperties}>
      <span className="section-label">
        <span className="layer-tab__dot" /> This layer
      </span>
      <label className="field">
        <span className="field__label">Name</span>
        <input
          className="input"
          value={current.name}
          maxLength={32}
          spellCheck={false}
          onChange={(e) => onRename(layer, e.target.value)}
          onBlur={(e) => !e.target.value.trim() && onRename(layer, layer === 0 ? "Base" : `Layer ${layer}`)}
        />
      </label>
      {layer === 0 ? (
        <p className="hint">Every other layer sits on top of the base layer, so it can't be deleted.</p>
      ) : confirming ? (
        <div className="confirm">
          <p>
            <strong>Delete {current.name}?</strong>{" "}
            {references
              ? `${references} key${references === 1 ? " switches" : "s switch"} to it. ${references === 1 ? "That key keeps" : "Those keys keep"} their tap key, or do nothing if they only switched layers.`
              : "No key switches to it."}
            {later > 0 && ` Keys for the ${later} layer${later === 1 ? "" : "s"} after it get renumbered.`}
          </p>
          <div className="confirm__actions">
            <button type="button" className="btn btn--sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              onClick={() => {
                setConfirming(false);
                onRemove(layer);
              }}
            >
              Delete layer
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn--ghost btn--sm btn--danger-text" onClick={() => setConfirming(true)}>
          <Trash2 size={14} /> Delete layer
        </button>
      )}
    </section>
  );
}

interface OverviewProps {
  state: AppState;
  keymap: Keymap;
  layer: number;
  activators: Activator[][];
  settings: BuildSettings;
  onSettings: (s: BuildSettings) => void;
  onLayer: (layer: number) => void;
  onHoverLayer: (layer: number | null) => void;
  onRename: (layer: number, name: string) => void;
  onRemove: (layer: number) => void;
  /** Adds a layer. Missing when no more layers fit. */
  onAdd?: () => void;
}

export function Overview({ state, keymap, layer, activators, settings, onSettings, onLayer, onHoverLayer, onRename, onRemove, onAdd }: OverviewProps) {
  const layerNames = keymap.layers.map((l) => l.name);
  return (
    <div className="inspector__body">
      <div className="empty">
        <span className="empty__icon">
          <KeyboardIcon size={18} />
        </span>
        <p>Click a key, or press it on your keyboard, to change what it does.</p>
      </div>

      <LayerSettings key={keymap.layers[layer]?.node} keymap={keymap} layer={layer} onRename={onRename} onRemove={onRemove} />

      <section className="inspector__section">
        <span className="section-label">Layers</span>
        <ul className="layer-list" onMouseLeave={() => onHoverLayer(null)}>
          {layerNames.map((name, i) => (
            <li key={i}>
              <button
                type="button"
                style={{ "--layer": layerColor(i) ?? "var(--text-3)" } as CSSProperties}
                onClick={() => onLayer(i)}
                onMouseEnter={() => onHoverLayer(i)}
              >
                <span className="layer-tab__dot" />
                <span className="layer-list__name">{name}</span>
                <span className="layer-list__how">
                  {i === 0
                    ? "Always on"
                    : activators[i].length
                      ? activators[i]
                          .slice(0, 3)
                          .map((a) => `${ACTIVATOR_VERB[a.kind]} ${a.label}${a.from ? ` on ${layerNames[a.from]}` : ""}`)
                          .join(", ")
                      : "No key turns it on"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn--ghost btn--sm layer-list__add" onClick={onAdd} disabled={!onAdd}>
          <Plus size={14} /> Add a layer
        </button>
      </section>

      <section className="inspector__section">
        <span className="section-label">Tandem's repeat behavior</span>
        <p className="prose">
          Any key can send its key on tap, switch layer or act as a modifier on hold, and repeat when you tap it and then hold it. Keys marked{" "}
          <span className="repeat-mark">2×</span> use it.
        </p>
      </section>

      <section className="inspector__section">
        <span className="section-label">Firmware</span>
        <label className="toggle">
          <input type="checkbox" checked={settings.studio} onChange={(e) => onSettings({ studio: e.target.checked })} />
          <span className="toggle__track" />
          <span>
            Include ZMK Studio
            <small>Flashes your workflow's Clique build. Turn off to flash the plain build instead.</small>
          </span>
        </label>
      </section>

      <section className="inspector__section">
        <span className="section-label">Where your layout lives</span>
        <p className="prose">
          Each save is a commit to <code>{state.repo.branch}</code> in {state.repo.owner}/{state.repo.name}, and GitHub Actions builds the firmware from it.
        </p>
        <a className="btn btn--ghost btn--sm" href={state.repo.url} target="_blank" rel="noreferrer">
          <GitHubMark size={14} /> Open on GitHub
        </a>
      </section>
    </div>
  );
}
