import { ArrowUpRight, Check, RotateCcw, Usb } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { parseBinding } from "../shared/bindings";
import { sameKey } from "../shared/keycodes";
import { MAX_LAYERS, addLayer, removeLayer, renameLayer } from "../shared/layers";
import type { AppState, BuildSettings, Keymap, Session } from "../shared/types";
import { api, useLive } from "./api";
import { KeyboardStatus, halfState } from "./components/HalfStatus";
import { KeyInspector, Overview } from "./components/Inspector";
import { Keyboard } from "./components/Keyboard";
import { LayerBar } from "./components/LayerBar";
import { Onboarding, needsOnboarding } from "./onboarding/Onboarding";
import { RepoMenu } from "./components/RepoMenu";
import { ThemeMenu } from "./components/ThemeMenu";
import { UpdateSheet } from "./components/UpdateSheet";
import { demoJob, demoSession } from "./lib/demo";
import { viewJob } from "./lib/job";
import { zmkCode } from "./lib/keyEvents";
import { activatorSummary, layerActivators, layerColor } from "./lib/layers";

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect x="2.5" y="8" width="12" height="16" rx="3.5" fill="currentColor" />
      <rect x="17.5" y="8" width="12" height="16" rx="3.5" fill="currentColor" opacity="0.45" />
    </svg>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    const demo = demoSession();
    if (demo) setSession(demo);
    else api.session().then(setSession, (e) => setSessionError(e.message));
  }, []);

  if (!session) {
    return (
      <div className="boot">
        <Logo />
        {sessionError ? <p className="boot__error">{sessionError}</p> : <p>Checking GitHub…</p>}
      </div>
    );
  }
  if (needsOnboarding(session)) return <Onboarding session={session} onSession={setSession} />;
  return <Editor session={session} onSession={setSession} />;
}

/** The key on a layer that sends `code` when tapped, if any. */
function keyForCode(bindings: string[], code: string): number {
  return bindings.findIndex((text) => {
    const b = parseBinding(text);
    return "key" in b && sameKey(b.key, code);
  });
}

function Editor({ session, onSession }: { session: Session; onSession: (s: Session) => void }) {
  const [state, setState] = useState<AppState | null>(null);
  const [draft, setDraft] = useState<Keymap | null>(null);
  const [layer, setLayer] = useState(0);
  const [hoverLayer, setHoverLayer] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [pressed, setPressed] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const live = useLive();
  const { devices, connected } = live;
  const [demo] = useState(demoJob);
  const job = demo ?? live.job;
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const notify = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await api.state();
      setState(s);
      setDraft(s.keymap);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const view = useMemo(() => (job ? viewJob(job) : null), [job]);

  // Reopen the sheet for an update in progress or cut short by a reload, and refresh when one ends.
  useEffect(() => {
    if (job?.running || job?.interrupted || demo) setSheetOpen(true);
  }, [job?.id, job?.running, job?.interrupted, demo]);
  useEffect(() => {
    if (view?.done) load();
  }, [view?.done, load]);

  const activators = useMemo(() => (draft ? layerActivators(draft) : []), [draft]);

  // Unsaved changes per layer, matched by node since layers can be added and
  // removed. A new, renamed or removed layer counts as one change.
  const changes = useMemo(() => {
    if (!state || !draft) return { perLayer: [] as number[], total: 0 };
    const saved = new Map(state.keymap.layers.map((l) => [l.node, l]));
    const perLayer = draft.layers.map((l) => {
      const before = saved.get(l.node);
      if (!before) return 1 + l.bindings.filter((b) => b !== "&trans").length;
      return l.bindings.filter((b, j) => b !== before.bindings[j]).length + (l.name !== before.name ? 1 : 0);
    });
    const removed = state.keymap.layers.filter((l) => !draft.layers.some((d) => d.node === l.node)).length;
    const timing = JSON.stringify(draft.repeat) !== JSON.stringify(state.keymap.repeat) ? 1 : 0;
    return { perLayer, total: perLayer.reduce((a, b) => a + b, 0) + removed + timing };
  }, [state, draft]);
  const dirty = changes.total > 0;

  const changed = useMemo(() => {
    const set = new Set<number>();
    if (!state || !draft || !draft.layers[layer]) return set;
    const current = draft.layers[layer];
    const before = state.keymap.layers.find((l) => l.node === current.node);
    current.bindings.forEach((b, i) => {
      if (before ? b !== before.bindings[i] : b !== "&trans") set.add(i);
    });
    return set;
  }, [state, draft, layer]);

  const layerOps = {
    add: () => {
      if (!draft || !state || draft.layers.length >= MAX_LAYERS) return;
      setDraft(addLayer(draft, state.layout.length));
      setLayer(draft.layers.length);
      setSelected(null);
    },
    rename: (index: number, name: string) => setDraft((d) => d && renameLayer(d, index, name)),
    remove: (index: number) => {
      if (!draft) return;
      setDraft(removeLayer(draft, index));
      setLayer((l) => (l === index ? index - 1 : l > index ? l - 1 : l));
      setSelected(null);
    },
  };

  const save = useCallback(async () => {
    if (!draft || !dirty) return;
    setSaving(true);
    try {
      const s = await api.saveKeymap(draft);
      setState(s);
      setDraft(s.keymap);
      notify(`Saved as ${s.buildId} on ${s.repo.branch}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, dirty, notify]);

  const update = useCallback(async () => {
    if (!draft) return;
    setSheetOpen(true);
    try {
      await api.update(dirty ? draft : undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [draft, dirty]);

  // Keyboard: ⌘S saves, Esc deselects, and pressing a key selects it on the board.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheetOpen || e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
        return;
      }
      const target = e.target instanceof Element ? e.target : document.body;
      if (target.closest("input, textarea, select, [contenteditable], .picker__popover, .menu")) return;
      if (e.key === "Escape") {
        setSelected(null);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.code === "Tab") return;
      if ((e.code === "Space" || e.code === "Enter") && target.closest("button, [role=button]")) return;
      if (!draft) return;
      const code = zmkCode(e.code);
      if (!code) return;
      let index = keyForCode(draft.layers[layer].bindings, code);
      if (index < 0) index = keyForCode(draft.layers[0].bindings, code);
      if (index < 0) return;
      e.preventDefault();
      setSelected(index);
      setPressed(index);
      clearTimeout(pressTimer.current);
      pressTimer.current = setTimeout(() => setPressed(null), 450);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, sheetOpen, draft, layer]);

  if (!state || !draft) {
    return (
      <div className="boot">
        <Logo />
        {error ? <p className="boot__error">{error}</p> : <p>Loading your layout…</p>}
      </div>
    );
  }

  const layerNames = draft.layers.map((l) => l.name);
  const left = devices && halfState(devices.left, state.buildId, dirty);
  const right = devices && halfState(devices.right, state.buildId, dirty);
  const needsSetup = left === "setup" || right === "setup";
  const upToDate = left === "current" && right === "current";
  const running = !!job?.running;

  const held = layer === 0 ? [] : activators[layer].filter((a) => a.from === 0).map((a) => a.key);
  const hovered = hoverLayer !== null && hoverLayer !== 0 ? activators[hoverLayer].map((a) => a.key) : [];
  const reach = layer === 0 ? null : activatorSummary(activators[layer]);

  const setBinding = (index: number, binding: string) =>
    setDraft((d) =>
      d && {
        ...d,
        layers: d.layers.map((l, i) => (i === layer ? { ...l, bindings: l.bindings.map((b, j) => (j === index ? binding : b)) } : l)),
      },
    );

  const status = dirty
    ? `${changes.total} unsaved change${changes.total === 1 ? "" : "s"}`
    : upToDate
      ? `Keyboard is up to date with ${state.buildId}`
      : `Saved as ${state.buildId}. Not on the keyboard yet.`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>Tandem</span>
          <RepoMenu
            repo={state.repo}
            login={session.login}
            onChangeRepo={async () => onSession(await api.disconnect())}
            onRestartSetup={async () => onSession(await api.restartOnboarding())}
            onSignOut={async () => onSession(await api.signOut())}
          />
        </div>

        <LayerBar
          keymap={draft}
          activators={activators}
          active={layer}
          changes={changes.perLayer}
          onSelect={(i) => {
            setLayer(i);
            setHoverLayer(null);
          }}
          onHover={setHoverLayer}
          onAdd={draft.layers.length < MAX_LAYERS ? layerOps.add : undefined}
        />

        <div className="topbar__right">
          <ThemeMenu />
          {api.caps.keyboard && devices && left && right && <KeyboardStatus devices={devices} left={left} right={right} />}
          {api.caps.engine === "browser" && api.caps.keyboard && devices?.needsAccess && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => api.connectKeyboard().catch((e: Error) => setError(e.message))}
              title="Let this browser open the keyboard's ports"
            >
              <Usb size={15} /> Connect
            </button>
          )}
          {dirty && (
            <button type="button" className="btn btn--ghost btn--icon" onClick={() => setDraft(state.keymap)} title="Discard changes" aria-label="Discard changes">
              <RotateCcw size={15} />
            </button>
          )}
          <button type="button" className="btn" onClick={save} disabled={!dirty || saving} title="Commit to GitHub (⌘S)">
            {saving ? "Saving…" : dirty ? `Save ${changes.total}` : "Saved"}
          </button>
          <button type="button" className="btn btn--primary" onClick={update} disabled={running}>
            {needsSetup ? "Set up and update" : "Update keyboard"}
          </button>
        </div>
      </header>

      {!connected && api.caps.engine === "helper" && <div className="banner banner--err">Can't reach the Tandem helper. Start it with npm run helper.</div>}
      {connected && needsSetup && !running && (
        <div className="banner">
          <span>
            <strong>Automatic updates aren't set up yet.</strong> The first update needs a key combo on each half that runs older firmware.
            Tandem walks you through it, and later updates need no key presses.
          </span>
          <button type="button" className="btn btn--sm" onClick={update}>
            Start setup <ArrowUpRight size={14} />
          </button>
        </div>
      )}
      {session.setup?.outdated && (
        <div className="banner">
          <span>
            <strong>A newer version of Tandem is ready for your repo.</strong> Updating makes one commit, then the next keyboard update
            installs it with no key presses.
          </span>
          <button
            type="button"
            className="btn btn--sm"
            disabled={installing}
            onClick={async () => {
              setInstalling(true);
              try {
                onSession((await api.install()).session);
                await load();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setInstalling(false);
              }
            }}
          >
            {installing ? "Committing…" : "Update Tandem"}
          </button>
        </div>
      )}
      {error && (
        <div className="banner banner--err" role="alert">
          {error}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <main className="main">
        <section className="canvas" onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
          <div className="canvas__caption" style={{ "--layer": layerColor(layer) ?? "var(--text-3)" } as CSSProperties}>
            <span className="layer-tab__dot" />
            <strong>{layerNames[layer]}</strong>
            <span>
              {layer === 0
                ? "Always on. Other layers sit on top of it."
                : reach
                  ? `${reach.verb} ${reach.keys.join(" or ")} to use it. Shaded keys are the ones you hold. Faded keys fall through to ${layerNames[0]}.`
                  : "No key turns this layer on yet."}
            </span>
          </div>
          <div className="canvas__board">
            <Keyboard
              layout={state.layout}
              bindings={draft.layers[layer].bindings}
              layerNames={layerNames}
              selected={selected}
              changed={changed}
              pressed={pressed}
              held={held}
              heldColor={layerColor(layer)}
              highlight={hovered}
              highlightColor={hoverLayer !== null ? layerColor(hoverLayer) : undefined}
              fallback={layer === 0 ? undefined : draft.layers[0].bindings}
              onSelect={(i) => setSelected((s) => (s === i ? null : i))}
            />
          </div>
          <p className={`canvas__status${dirty ? " is-dirty" : ""}`}>{status}</p>
        </section>

        <aside className="inspector" aria-label="Key settings">
          {selected === null ? (
            <Overview
              state={state}
              keymap={draft}
              layer={layer}
              activators={activators}
              settings={state.settings}
              onSettings={async (s: BuildSettings) => setState(await api.saveSettings(s))}
              onLayer={setLayer}
              onHoverLayer={setHoverLayer}
              onRename={layerOps.rename}
              onRemove={layerOps.remove}
              onAdd={draft.layers.length < MAX_LAYERS ? layerOps.add : undefined}
            />
          ) : (
            <KeyInspector
              key={`${layer}:${selected}`}
              layoutKey={state.layout[selected]}
              layerIndex={layer}
              layerNames={layerNames}
              binding={draft.layers[layer].bindings[selected]}
              fallback={layer === 0 ? undefined : draft.layers[0].bindings[selected]}
              repeat={draft.repeat}
              onChange={(b) => setBinding(selected, b)}
              onRepeatChange={(repeat) => setDraft((d) => d && { ...d, repeat })}
            />
          )}
        </aside>
      </main>

      {toast && (
        <div className="toast" role="status">
          <Check size={15} /> {toast}
        </div>
      )}

      {sheetOpen && view && (
        <UpdateSheet
          view={view}
          keymap={draft}
          layout={state.layout}
          onAct={(a) => api.act(a).catch((e: Error) => setError(e.message))}
          onCancel={() => api.cancel()}
          onClose={() => setSheetOpen(false)}
          onRetry={update}
        />
      )}
    </div>
  );
}
