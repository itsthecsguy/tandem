import { Check, Loader2, Plug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AppState, Session } from "../../shared/types";
import { api, useLive } from "../api";
import { UpdateProgress, updateHeading } from "../components/UpdateSheet";
import { viewJob } from "../lib/job";

export function FirmwareStep({ onSession }: { onSession: (s: Session) => void }) {
  const { devices, job } = useLive();
  const [state, setState] = useState<AppState | null>(null);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.state().then(setState, (e) => setError(e.message));
  }, []);

  const view = useMemo(() => (job && (started || job.running || job.interrupted) ? viewJob(job) : null), [job, started]);

  const finish = async () => {
    setBusy(true);
    try {
      onSession(await api.completeOnboarding());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const start = async () => {
    setError(null);
    setStarted(true);
    try {
      await api.update();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!state || !devices) {
    return (
      <p className="hint ob__status">
        <Loader2 size={13} className="spin" /> Checking your keyboard
      </p>
    );
  }

  const left = devices.left;
  const right = devices.right;
  const both = left.mode !== "missing" && right.mode !== "missing";
  const tandem = left.autoflash && right.autoflash;
  const current = tandem && left.build === state.buildId && right.build === state.buildId;

  if (view) {
    return (
      <>
        <h1>{updateHeading(view)}</h1>
        <p className="lede">
          {view.setup
            ? "This is the only update that needs your hands. Tandem builds your firmware on GitHub, then walks you through putting each half in update mode."
            : "Tandem builds your firmware on GitHub and updates both halves. No key presses needed."}
        </p>
        <div className="ob__progress">
          <UpdateProgress view={view} keymap={state.keymap} layout={state.layout} onAct={(a) => api.act(a).catch((e: Error) => setError(e.message))} />
        </div>
        {error && <p className="callout callout--err">{error}</p>}
        <div className="ob__actions">
          {view.running ? (
            <button type="button" className="btn" onClick={() => api.cancel()}>
              Cancel
            </button>
          ) : view.error ? (
            <>
              <button type="button" className="btn btn--ghost" onClick={finish} disabled={busy}>
                Skip for now
              </button>
              <button type="button" className="btn btn--primary btn--lg" onClick={start}>
                Try again
              </button>
            </>
          ) : (
            <>
              <span />
              <button type="button" className="btn btn--primary btn--lg" onClick={finish} disabled={busy}>
                Open the editor
              </button>
            </>
          )}
        </div>
      </>
    );
  }

  if (current) {
    return (
      <>
        <h1>Your keyboard is ready</h1>
        <p className="lede">Both halves run Tandem firmware built from your repo's latest commit. From now on, updates need no key presses.</p>
        <p className="callout callout--ok">
          <Check size={15} /> Both halves are on build <code>{state.buildId}</code>.
        </p>
        <div className="ob__actions">
          <span />
          <button type="button" className="btn btn--primary btn--lg" onClick={finish} disabled={busy}>
            Open the editor
          </button>
        </div>
      </>
    );
  }

  if (tandem) {
    return (
      <>
        <h1>Update your keyboard</h1>
        <p className="lede">
          Your keyboard already runs Tandem firmware, so the one-time setup isn't needed. Its build ({left.build}) is older than your repo's
          latest ({state.buildId}). Updating takes a few minutes and needs no key presses.
        </p>
        {error && <p className="callout callout--err">{error}</p>}
        <div className="ob__actions">
          <button type="button" className="btn btn--ghost" onClick={finish} disabled={busy}>
            Later
          </button>
          <button type="button" className="btn btn--primary btn--lg" onClick={start}>
            Update now
          </button>
        </div>
      </>
    );
  }

  if (!api.caps.flash) {
    return (
      <>
        <h1>Install Tandem firmware</h1>
        <p className="lede">
          This browser can't reach the keyboard, so an update here ends with you copying two files. In Chrome or Edge, Tandem copies them for
          you.
        </p>
        <ol className="ob__plan">
          <li>
            <strong>GitHub builds your firmware.</strong> About 3 minutes, from your repo's latest commit.
          </li>
          <li>
            <strong>You copy it onto each half.</strong> Tandem gives you both files and shows how to put each half in update mode.
          </li>
        </ol>
        {error && <p className="callout callout--err">{error}</p>}
        <div className="ob__actions">
          <button type="button" className="btn btn--ghost" onClick={finish} disabled={busy}>
            Do this later
          </button>
          <button type="button" className="btn btn--primary btn--lg" onClick={start}>
            Start
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Install Tandem firmware</h1>
      <p className="lede">
        One update sets up everything else. After it, updating your keyboard is: plug in both halves, click Update.
      </p>
      <ol className="ob__plan">
        <li>
          <strong>GitHub builds your firmware.</strong> About 3 minutes, from your repo's latest commit.
        </li>
        <li>
          <strong>You put each half in update mode.</strong> Tandem shows you which two keys to press, right half first.
        </li>
        {api.caps.engine === "browser" ? (
          <li>
            <strong>You allow each half's update port.</strong> Chrome lists one entry, ADV360PRO. Tandem sends the firmware over it and checks
            that each half comes back running it.
          </li>
        ) : (
          <li>
            <strong>Tandem copies the firmware</strong> and checks that each half comes back running it.
          </li>
        )}
      </ol>
      {api.caps.engine === "browser" && <p className="hint">After this, updates need no key presses and no clicks beyond Update.</p>}
      {!both && api.caps.engine === "helper" && (
        <p className="callout">
          <Plug size={15} /> Connect both halves with USB cables. Tandem will wait for them.
        </p>
      )}
      {error && <p className="callout callout--err">{error}</p>}
      <div className="ob__actions">
        <button type="button" className="btn btn--ghost" onClick={finish} disabled={busy}>
          Do this later
        </button>
        <button type="button" className="btn btn--primary btn--lg" onClick={start}>
          Start
        </button>
      </div>
    </>
  );
}
