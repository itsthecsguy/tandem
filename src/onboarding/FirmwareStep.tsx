import { Check, Loader2, Plug, Usb } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AppState, Session } from "../../shared/types";
import { api, useLive } from "../api";
import { UpdateProgress, isSetup, updateHeading } from "../components/UpdateSheet";
import { viewJob } from "../lib/job";

export function FirmwareStep({ onSession }: { onSession: (s: Session) => void }) {
  const { devices, job } = useLive();
  const [state, setState] = useState<AppState | null>(null);
  const [started, setStarted] = useState(false);
  /** The update started as the one-time setup: some half couldn't restart by itself. */
  const [firstTime, setFirstTime] = useState(false);
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
    setFirstTime(!(devices?.left.autoflash && devices?.right.autoflash));
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
    const setup = isSetup(view, firstTime);
    return (
      <>
        <h1>{updateHeading(view, firstTime)}</h1>
        <p className="lede">
          {view.done
            ? setup
              ? "Both halves run Tandem firmware now."
              : "Both halves run your latest firmware."
            : setup
              ? "You only do this once. When it's your turn, Tandem shows what to do right here, one step at a time."
              : "Tandem builds your firmware on GitHub and updates both halves. No key presses needed."}
        </p>
        <div className="ob__progress">
          <UpdateProgress
            view={view}
            keymap={state.keymap}
            layout={state.layout}
            firstTime={firstTime}
            onAct={(a) => api.act(a).catch((e: Error) => setError(e.message))}
          />
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

  const browser = api.caps.engine === "browser";
  return (
    <>
      <h1>One-time setup</h1>
      <p className="lede">
        Tandem puts its own firmware on both halves. You do this once, and it takes about 5 minutes. After it, every update is one click,
        with no keys to press{browser ? " and nothing to pick in Chrome" : ""}.
      </p>

      <h2 className="ob__subhead">What you'll do</h2>
      {browser ? (
        <>
          <p className="ob__para">First GitHub builds your firmware, which takes about 3 minutes. Then:</p>
          <ol className="ob__plan">
            <li>
              <span>
                <strong>Right half: press two keys, then connect ADV360PRO in Chrome.</strong> Tandem lights the keys up on a picture of your
                layout, and Chrome's list has one entry. The firmware goes on as soon as you connect.
              </span>
            </li>
            <li>
              <span>
                <strong>Left half: the same two steps.</strong>
              </span>
            </li>
            <li>
              <span>
                <strong>Connect the new ports in Chrome.</strong> Once both halves have the firmware, Chrome asks once for each half's new
                port, and Tandem names the entry to pick.
              </span>
            </li>
          </ol>
        </>
      ) : (
        <>
          <p className="ob__para">First GitHub builds your firmware, which takes about 3 minutes. Then, right half first, for each half:</p>
          <ol className="ob__plan">
            <li>
              <span>
                <strong>Press two keys on the keyboard.</strong> Tandem lights them up on a picture of your layout.
              </span>
            </li>
            <li>
              <span>
                <strong>Wait while Tandem copies the firmware.</strong> It checks that the half comes back running it.
              </span>
            </li>
          </ol>
        </>
      )}

      <ul className="ob__notes">
        <li>Keep both halves plugged in with USB cables until setup is done.</li>
        <li>
          While a half is in update mode, a drive named ADV360PRO shows up on your computer. Leave it alone.{" "}
          {browser ? "Tandem sends the firmware over USB itself." : "Tandem copies the firmware to it."} On a Mac, a warning that the drive
          wasn't ejected properly is normal.
        </li>
        {left.mode === "app" && (
          <li>If a key combo lands on the wrong half, that's fine. Tandem updates that half first and asks for the other one after.</li>
        )}
      </ul>

      {browser && api.caps.keyboard && left.mode === "missing" && (
        <div className="callout connect-ports">
          <span>
            <strong>Tandem can't see the left half yet.</strong> Connect it before you start, so Tandem can tell the halves apart while you
            press keys. In Chrome's list, pick <strong>Adv360 Pro</strong> and click Connect.
          </span>
          <button type="button" className="btn" onClick={() => api.connectKeyboard().catch((e: Error) => setError(e.message))}>
            <Usb size={15} /> Connect keyboard
          </button>
        </div>
      )}

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
          Start setup
        </button>
      </div>
    </>
  );
}
