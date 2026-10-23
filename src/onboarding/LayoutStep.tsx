import { ArrowLeft, Check, FolderGit2, GitFork, Loader2, Lock, Plus, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ImportedLayout, KeyboardInfo, RepoOption, Session } from "../../shared/types";
import { api } from "../api";
import { Keyboard, PLAIN_KEYS } from "../components/Keyboard";
import { GitHubMark } from "../components/GitHubMark";

type View = "choose" | "existing" | "new";

function ago(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function Back({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="ob__back" onClick={onClick}>
      <ArrowLeft size={14} /> Back
    </button>
  );
}

// Choose: link a repo, or start a new one.

function Choose({ keyboard, onView, onSession }: { keyboard: KeyboardInfo | null; onView: (v: View) => void; onSession: (s: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const found = keyboard?.tandemRepo;

  const useFound = async () => {
    if (!found) return;
    setBusy(true);
    setError(null);
    try {
      const [owner, name] = found.split("/");
      const { suggested } = await api.branches(owner, name);
      onSession(await api.connect({ owner, name, branch: suggested }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Where should your layout live?</h1>
      <p className="lede">Tandem keeps your layout in a GitHub repo you own. Every change is a commit, and GitHub Actions builds the firmware from it.</p>

      {found && (
        <div className="found">
          <GitHubMark size={18} />
          <div>
            <strong>Your keyboard's firmware came from {found}</strong>
            <span>Use that repo and keep going where you left off.</span>
          </div>
          <button type="button" className="btn btn--primary" onClick={useFound} disabled={busy}>
            {busy ? "Connecting…" : "Use this repo"}
          </button>
        </div>
      )}

      <div className="option-cards">
        <button type="button" className="option-card" onClick={() => onView("existing")}>
          <span className="option-card__icon">
            <FolderGit2 size={20} />
          </span>
          <strong>Use a repo I have</strong>
          <span>Your Adv360 config on GitHub, such as a fork of Kinesis's. Tandem adds itself in one commit and keeps your keymap as it is.</span>
        </button>
        <button type="button" className="option-card" onClick={() => onView("new")}>
          <span className="option-card__icon">
            <Plus size={20} />
          </span>
          <strong>Start a new repo</strong>
          <span>Tandem creates a repo with Kinesis's config and Tandem set up. Start from the layout on your keyboard, or from Kinesis's default.</span>
        </button>
      </div>
      {error && <p className="callout callout--err">{error}</p>}
    </>
  );
}

// Existing: pick a repo and branch.

/** Browser sign-in starts with public repos only. Ask GitHub for private ones on request. */
function PrivateRepos({ session, children }: { session: Session; children: string }) {
  const [busy, setBusy] = useState(false);
  if (session.privateRepos || session.source !== "oauth") return null;
  return (
    <p className="hint">
      {children}{" "}
      <button
        type="button"
        className="link"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await api.signIn({ privateRepos: true }).catch(() => setBusy(false));
        }}
      >
        Allow private repos
      </button>
    </p>
  );
}

function Existing({ session, onBack, onSession }: { session: Session; onBack: () => void; onSession: (s: Session) => void }) {
  const [repos, setRepos] = useState<RepoOption[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<RepoOption | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.repos().then(setRepos, (e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!picked) return;
    setBranches(null);
    api.branches(picked.owner, picked.name).then(
      (b) => {
        setBranches(b.branches);
        setBranch(b.suggested);
      },
      (e) => setError(e.message),
    );
  }, [picked]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q)).slice(0, 8);
  }, [repos, query]);

  return (
    <>
      <Back onClick={onBack} />
      <h1>Choose your keyboard repo</h1>
      <p className="lede">Pick the repo with your Adv360 config. Tandem commits your layout changes to the branch you choose.</p>

      <div className="repo-search">
        <Search size={15} />
        <input placeholder="Filter repos" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <PrivateRepos session={session}>Don't see a private repo?</PrivateRepos>

      <div className="repo-list" role="radiogroup" aria-label="Repositories">
        {!repos && !error && (
          <p className="hint">
            <Loader2 size={13} className="spin" /> Loading your repos
          </p>
        )}
        {shown.map((r) => {
          const on = picked?.fullName === r.fullName;
          return (
            <button key={r.fullName} type="button" role="radio" aria-checked={on} className={`repo${on ? " is-on" : ""}`} onClick={() => setPicked(r)}>
              <span className="choice__dot" />
              <span className="repo__text">
                <span className="repo__name">
                  {r.fullName}
                  {r.fork && <GitFork size={13} aria-label="fork" />}
                  {r.private && <Lock size={12} aria-label="private" />}
                </span>
                {r.description && <span className="repo__desc">{r.description}</span>}
              </span>
              <span className="repo__when">{ago(r.pushedAt)}</span>
            </button>
          );
        })}
      </div>

      {picked && (
        <label className="field">
          <span className="field__label">Branch</span>
          {branches ? (
            <select className="input" value={branch} onChange={(e) => setBranch(e.target.value)}>
              {branches.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          ) : (
            <span className="hint">
              <Loader2 size={13} className="spin" /> Loading branches
            </span>
          )}
        </label>
      )}

      {error && <p className="callout callout--err">{error}</p>}

      <div className="ob__actions">
        <span />
        <button
          type="button"
          className="btn btn--primary btn--lg"
          disabled={!picked || !branch || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              onSession(await api.connect({ owner: picked!.owner, name: picked!.name, branch }));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Connecting…" : "Continue"}
        </button>
      </div>
    </>
  );
}

// New: create a repo from Kinesis's config, optionally with the keyboard's layout.

function UnlockPrompt({ layout }: { layout: KeyboardInfo["layout"] }) {
  // On Kinesis's default layout, &studio_unlock is Mod + the key in Esc's spot.
  const mod = layout.findIndex((k) => k.label === "mod2");
  const esc = layout.findIndex((k) => k.row === 2 && k.col === 0);
  return (
    <div className="guide">
      <div className="guide__head">
        <span className="guide__badge">Unlock your keyboard</span>
        <h3>Press the Studio unlock key</h3>
        <p>
          Your keyboard keeps its layout locked until you allow it. On Kinesis's default layout, hold <strong>Mod</strong> and press{" "}
          <strong>Esc</strong>. If you moved that key, press your Studio unlock key instead.
        </p>
      </div>
      {mod >= 0 && esc >= 0 && (
        <div className="guide__board">
          <Keyboard layout={layout} bindings={PLAIN_KEYS} layerNames={[]} highlight={[mod, esc]} labels={{ [mod]: "1", [esc]: "2" }} compact />
        </div>
      )}
      <p className="guide__wait">
        <Loader2 size={14} className="spin" /> Waiting for the keyboard
      </p>
    </div>
  );
}

function Preview({ imported }: { imported: ImportedLayout }) {
  const [layer, setLayer] = useState(0);
  const names = imported.layers.map((l) => l.name);
  return (
    <div className="preview">
      <div className="preview__head">
        <span className="callout-ok-mark">
          <Check size={14} />
        </span>
        <strong>
          Read {imported.layers.length} layer{imported.layers.length === 1 ? "" : "s"} from your keyboard
        </strong>
        <span className="hint">{imported.source === "tandem" ? "from Tandem firmware" : "over ZMK Studio"}</span>
      </div>
      <div className="segmented">
        {names.map((n, i) => (
          <button key={i} type="button" className={i === layer ? "is-on" : ""} onClick={() => setLayer(i)}>
            {n}
          </button>
        ))}
      </div>
      <div className="preview__board">
        <Keyboard layout={imported.layout} bindings={imported.layers[layer].bindings} layerNames={names} />
      </div>
      {imported.unknown.length > 0 && (
        <p className="callout">
          {imported.unknown.length} key{imported.unknown.length === 1 ? " uses a behavior" : "s use behaviors"} Tandem can't translate yet, so{" "}
          {imported.unknown.length === 1 ? "it was" : "they were"} left empty: {imported.unknown.slice(0, 3).join("; ")}
          {imported.unknown.length > 3 ? "…" : ""}
        </p>
      )}
    </div>
  );
}

function NewRepo({
  session,
  keyboard,
  onBack,
  onSession,
}: {
  session: Session;
  keyboard: KeyboardInfo | null;
  onBack: () => void;
  onSession: (s: Session) => void;
}) {
  const canRead = !!keyboard && (keyboard.tandemKeymap || !!keyboard.studio?.available);
  const [name, setName] = useState("adv360-config");
  const [isPrivate, setPrivate] = useState(true);
  const [source, setSource] = useState<"keyboard" | "kinesis">(canRead ? "keyboard" : "kinesis");
  const [reading, setReading] = useState(false);
  const [imported, setImported] = useState<ImportedLayout | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = async () => {
    setReading(true);
    setError(null);
    try {
      setImported(await api.readKeyboard());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  };

  const validName = /^[A-Za-z0-9._-]{1,100}$/.test(name);
  const needsPrivate = isPrivate && !session.privateRepos && session.source === "oauth";
  const ready = validName && (source === "kinesis" || !!imported) && !needsPrivate;

  return (
    <>
      <Back onClick={onBack} />
      <h1>Start a new repo</h1>
      <p className="lede">Tandem creates a repo on your account with Kinesis's Adv360 Pro config and Tandem already set up.</p>

      <div className="form-row">
        <label className="field">
          <span className="field__label">Repo name</span>
          <input className="input" value={name} spellCheck={false} onChange={(e) => setName(e.target.value.trim())} />
          {!validName && <span className="field__error">Use letters, numbers, dots, dashes and underscores.</span>}
        </label>
        <div className="field">
          <span className="field__label">Visibility</span>
          <div className="segmented">
            <button type="button" className={isPrivate ? "is-on" : ""} onClick={() => setPrivate(true)}>
              Private
            </button>
            <button type="button" className={!isPrivate ? "is-on" : ""} onClick={() => setPrivate(false)}>
              Public
            </button>
          </div>
        </div>
      </div>
      {isPrivate && <p className="hint">Private repos get 2,000 free GitHub Actions minutes a month. A build takes about 3.</p>}
      {needsPrivate && <PrivateRepos session={session}>Tandem needs your OK to create private repos.</PrivateRepos>}

      <div className="field">
        <span className="field__label">Start from</span>
        <div className="choices choices--cards">
          <button
            type="button"
            className={`choice${source === "keyboard" ? " is-on" : ""}`}
            disabled={!canRead}
            aria-pressed={source === "keyboard"}
            onClick={() => setSource("keyboard")}
          >
            <span className="choice__dot" />
            <span className="choice__text">
              <span className="choice__title">
                The layout on my keyboard <Sparkles size={13} />
              </span>
              <span className="choice__desc">
                {!keyboard
                  ? "Connect the keyboard to use this."
                  : keyboard.tandemKeymap
                    ? "Tandem firmware reports its exact keymap."
                    : keyboard.studio?.available
                      ? "Read over ZMK Studio. You'll press an unlock key once."
                      : "This keyboard's firmware doesn't share its layout."}
              </span>
            </span>
          </button>
          <button type="button" className={`choice${source === "kinesis" ? " is-on" : ""}`} aria-pressed={source === "kinesis"} onClick={() => setSource("kinesis")}>
            <span className="choice__dot" />
            <span className="choice__text">
              <span className="choice__title">Kinesis's default layout</span>
              <span className="choice__desc">The layout the keyboard ships with.</span>
            </span>
          </button>
        </div>
      </div>

      {source === "keyboard" && !imported && (
        <>
          {reading && keyboard?.studio?.locked && !keyboard.tandemKeymap ? (
            <UnlockPrompt layout={keyboard.layout} />
          ) : (
            <button type="button" className="btn" onClick={read} disabled={reading}>
              {reading ? (
                <>
                  <Loader2 size={14} className="spin" /> Reading your layout
                </>
              ) : (
                "Read my layout"
              )}
            </button>
          )}
        </>
      )}
      {source === "keyboard" && imported && <Preview imported={imported} />}

      {error && <p className="callout callout--err">{error}</p>}

      <div className="ob__actions">
        <span />
        <button
          type="button"
          className="btn btn--primary btn--lg"
          disabled={!ready || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              onSession(await api.newRepo({ name, private: isPrivate, fromKeyboard: source === "keyboard" }));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Creating your repo…" : `Create ${name || "repo"}`}
        </button>
      </div>
    </>
  );
}

// Install: review and make the commit that adds Tandem to a linked repo.

function describeChanges(changes: string[]) {
  const lines: { title: string; detail: string }[] = [];
  if (changes.some((c) => c.startsWith("tandem/"))) {
    lines.push({ title: "Add the Tandem firmware module", detail: "tandem/zmk-tandem lets each half restart into update mode on request and report its build and layout." });
  }
  if (changes.includes(".github/workflows/build.yml")) {
    lines.push({ title: "Build it into your firmware", detail: "Updates .github/workflows/build.yml so every build includes the module, tagged with the commit and repo." });
  }
  if (changes.some((c) => c.endsWith(".keymap"))) {
    lines.push({ title: "Prepare your keymap", detail: "Adds Tandem's repeat behaviors and switches keys that already repeat on tap-then-hold to them. Your keys behave the same." });
  }
  return lines;
}

function Install({ session, onSession }: { session: Session; onSession: (s: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repo = session.repo!;
  const setup = session.setup;

  return (
    <>
      <h1>
        {setup?.outdated ? "Update Tandem in" : "Add Tandem to"} {repo.owner}/{repo.name}
      </h1>
      <p className="lede">
        Tandem makes one commit to <code>{repo.branch}</code> and leaves your keymap's keys as they are. You can see the commit on GitHub and
        revert it like any other.
      </p>

      {!setup ? (
        <p className="hint">
          <Loader2 size={13} className="spin" /> Reading your repo
        </p>
      ) : setup.blocker ? (
        <p className="callout callout--err">{setup.blocker}</p>
      ) : (
        <ul className="changes">
          {describeChanges(setup.changes).map((c) => (
            <li key={c.title}>
              <Check size={15} />
              <span>
                <strong>{c.title}</strong>
                {c.detail}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="callout callout--err">{error}</p>}

      <div className="ob__actions">
        <button type="button" className="btn btn--ghost" onClick={async () => onSession(await api.disconnect())} disabled={busy}>
          Choose another repo
        </button>
        <button
          type="button"
          className="btn btn--primary btn--lg"
          disabled={busy || !setup || !!setup.blocker}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              onSession((await api.install()).session);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Committing…" : setup?.outdated ? "Update Tandem" : "Add Tandem"}
        </button>
      </div>
    </>
  );
}

export function LayoutStep({ session, keyboard, onSession }: { session: Session; keyboard: KeyboardInfo | null; onSession: (s: Session) => void }) {
  const [view, setView] = useState<View>("choose");
  if (session.repo) return <Install session={session} onSession={onSession} />;
  if (view === "existing") return <Existing session={session} onBack={() => setView("choose")} onSession={onSession} />;
  if (view === "new") return <NewRepo session={session} keyboard={keyboard} onBack={() => setView("choose")} onSession={onSession} />;
  return <Choose keyboard={keyboard} onView={setView} onSession={onSession} />;
}
