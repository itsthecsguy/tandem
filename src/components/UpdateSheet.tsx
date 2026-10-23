import { ArrowUpRight, Check, Circle, Loader2, Minus, Plug, X } from "lucide-react";

import type { Keymap, LayoutKey, Side, StepState } from "../../shared/types";
import { bootloaderCombo } from "../lib/guide";
import { type JobView, STEP_ORDER, STEP_TITLES } from "../lib/job";
import { GitHubMark } from "./GitHubMark";
import { Keyboard } from "./Keyboard";

function StepIcon({ state }: { state: StepState }) {
  switch (state) {
    case "active":
      return <Loader2 size={16} className="spin" />;
    case "done":
      return <Check size={16} />;
    case "skipped":
      return <Minus size={16} />;
    case "error":
      return <X size={16} />;
    default:
      return <Circle size={16} />;
  }
}

function sideName(side: Side) {
  return side === "left" ? "left" : "right";
}

function ManualGuide({
  side,
  reason,
  keymap,
  layout,
}: {
  side: Side;
  reason: "no-autoflash" | "no-response";
  keymap: Keymap;
  layout: LayoutKey[];
}) {
  const combo = bootloaderCombo(side, keymap, layout);

  return (
    <div className="guide">
      <div className="guide__head">
        <span className="guide__badge">One-time step</span>
        <h3>Put the {sideName(side)} half in update mode</h3>
        <p>
          {reason === "no-autoflash"
            ? "Its current firmware can't restart into update mode by itself yet. After this update it can, and you won't need to do this again."
            : "It didn't restart into update mode by itself. Do it by hand this once."}
        </p>
      </div>

      <div className={`guide__body${combo ? "" : " guide__body--single"}`}>
        {combo && (
          <div className="guide__board">
            <Keyboard
              layout={layout}
              bindings={keymap.layers[0].bindings}
              layerNames={keymap.layers.map((l) => l.name)}
              highlight={[combo.hold, combo.press]}
              labels={{ [combo.hold]: "1", [combo.press]: "2" }}
              compact
            />
          </div>
        )}

        <ol className="guide__steps">
          {combo ? (
            <li>
              Hold the <strong>{combo.layerName}</strong> key <span className="num">1</span>, then press{" "}
              <span className="num">2</span> on the {sideName(side)} half.
            </li>
          ) : null}
          <li>
            {combo ? "Or double-click" : "Double-click"} the reset button on the {sideName(side)} half.
          </li>
        </ol>
      </div>
      <p className="guide__wait">
        <Loader2 size={14} className="spin" /> Tandem continues as soon as the half shows up as a drive.
      </p>
    </div>
  );
}

interface Props {
  view: JobView;
  keymap: Keymap;
  layout: LayoutKey[];
  onCancel: () => void;
  onClose: () => void;
  onRetry: () => void;
}

/** Progress of an update: the steps, and any guide or notice the user needs. */
export function UpdateProgress({ view, keymap, layout }: { view: JobView; keymap: Keymap; layout: LayoutKey[] }) {
  return (
    <>
      <ol className="steps">
        {STEP_ORDER.map((id) => {
          const step = view.steps[id];
          return (
            <li key={id} className={`step step--${step.state}`}>
              <span className="step__icon">
                <StepIcon state={step.state} />
              </span>
              <span className="step__title">{STEP_TITLES[id]}</span>
              {step.detail && <span className="step__detail">{step.detail}</span>}
            </li>
          );
        })}
      </ol>

      {view.runUrl && (
        <a className="run-link" href={view.runUrl} target="_blank" rel="noreferrer">
          <GitHubMark size={14} /> See the build on GitHub <ArrowUpRight size={13} />
        </a>
      )}

      {view.plugIn && (
        <div className="notice">
          <Plug size={16} />
          <span>Connect the {sideName(view.plugIn)} half with a USB cable.</span>
        </div>
      )}

      {view.manual && <ManualGuide side={view.manual.side} reason={view.manual.reason} keymap={keymap} layout={layout} />}

      {view.done && (
        <div className="notice notice--ok">
          <Check size={16} />
          <span>
            Both halves are running build <code>{view.done}</code>.
            {view.setup && " Automatic updates are set up. Next time, connect both halves and click Update."}
          </span>
        </div>
      )}

      {view.error && (
        <div className="notice notice--err">
          <X size={16} />
          <span>{view.error}</span>
        </div>
      )}
    </>
  );
}

export function updateHeading(view: JobView): string {
  if (view.done) return "Your keyboard is updated";
  if (view.error) return "The update stopped";
  return view.setup ? "Setting up automatic updates" : "Updating your keyboard";
}

export function UpdateSheet({ view, keymap, layout, onCancel, onClose, onRetry }: Props) {
  return (
    <div className="scrim" role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <header className="sheet__head">
          <h2 id="sheet-title">{updateHeading(view)}</h2>
          {!view.running && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          )}
        </header>

        <UpdateProgress view={view} keymap={keymap} layout={layout} />

        <footer className="sheet__foot">
          {view.running ? (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          ) : view.error ? (
            <>
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
              <button type="button" className="btn btn--primary" onClick={onRetry}>
                Try again
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
