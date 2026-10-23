import { ArrowUpRight, Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { Session } from "../../shared/types";
import { api } from "../api";
import { GitHubMark } from "../components/GitHubMark";

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command">
      <code>{command}</code>
      <button
        type="button"
        className="icon-btn"
        aria-label="Copy command"
        onClick={() => {
          navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}

export function SignInStep({ session, onSession }: { session: Session; onSession: (s: Session) => void }) {
  const [code, setCode] = useState<{ userCode: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(session.signInError ?? null);
  const [busy, setBusy] = useState(false);
  const browser = api.caps.engine === "browser";

  useEffect(() => {
    if (!code) return;
    const timer = setInterval(async () => {
      const s = await api.deviceStatus();
      if (s?.status === "done") {
        clearInterval(timer);
        onSession(await api.session());
      } else if (s?.status === "error") {
        clearInterval(timer);
        setError(s.error ?? "Sign-in failed");
        setCode(null);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [code, onSession]);

  // Leaves the page for GitHub, so it only comes back here on failure.
  const signIn = async (privateRepos: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await api.signIn({ privateRepos });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (session.signedIn && session.missingScopes.length) {
    return (
      <>
        <h1>One more permission</h1>
        <p className="lede">
          Tandem needs the <code>{session.missingScopes.join(" and ")}</code> permission so it can add itself to your repo's build
          workflow. GitHub won't let an app change workflow files without it.
        </p>
        {session.source === "gh" ? (
          <div className="ob__block">
            <p className="prose">Run this in Terminal and approve it in your browser:</p>
            <CopyCommand command={`gh auth refresh -s ${session.missingScopes.join(",")}`} />
          </div>
        ) : session.source === "oauth" ? (
          <p className="prose">Sign in again and approve it on GitHub.</p>
        ) : (
          <p className="prose">Sign out and sign in again to grant it.</p>
        )}
        {error && <p className="callout callout--err">{error}</p>}
        <div className="ob__actions">
          <button type="button" className="btn btn--ghost" onClick={async () => onSession(await api.signOut())}>
            Sign out
          </button>
          {session.source === "oauth" ? (
            <button type="button" className="btn btn--primary btn--lg" disabled={busy} onClick={() => signIn(session.privateRepos)}>
              {busy ? "Opening GitHub…" : "Sign in again"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--lg"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  onSession(await api.session());
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Checking…" : "Check again"}
            </button>
          )}
        </div>
      </>
    );
  }

  const oauth = browser && session.oauth;
  const device = !browser && session.deviceFlow;

  return (
    <>
      <h1>Sign in with GitHub</h1>
      <p className="lede">
        {browser
          ? "Your layout lives in a GitHub repo you own, and GitHub Actions builds the firmware. Tandem runs in this browser tab and keeps your GitHub sign-in here, not on a server."
          : "Your layout lives in a GitHub repo you own, and GitHub Actions builds the firmware. Tandem has no servers of its own. Only copying firmware to the keyboard runs on this Mac."}
      </p>

      {code ? (
        <div className="device-code">
          <span className="section-label">Enter this code on GitHub</span>
          <strong>{code.userCode}</strong>
          <a className="btn btn--primary" href={code.url} target="_blank" rel="noreferrer">
            Open GitHub <ArrowUpRight size={14} />
          </a>
          <p className="hint">
            <Loader2 size={13} className="spin" /> Waiting for you to approve
          </p>
        </div>
      ) : (
        <div className="ob__choices">
          {oauth && (
            <>
              <button type="button" className="btn btn--primary btn--lg" disabled={busy} onClick={() => signIn(false)}>
                <GitHubMark /> {busy ? "Opening GitHub…" : "Sign in with GitHub"}
              </button>
              <p className="hint">Tandem asks for your public repos and their workflows. You can allow private repos later.</p>
            </>
          )}
          {device && (
            <button
              type="button"
              className="btn btn--primary btn--lg"
              onClick={async () => {
                setError(null);
                try {
                  setCode(await api.startDevice());
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <GitHubMark /> Sign in with GitHub
            </button>
          )}
          {session.ghLogin && (
            <button
              type="button"
              className={`btn btn--lg${oauth || device ? "" : " btn--primary"}`}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  onSession(await api.useGh());
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <GitHubMark /> Continue as @{session.ghLogin}
              <small>with your GitHub CLI login</small>
            </button>
          )}
          {!oauth && !device && !session.ghLogin && (
            <p className="callout">
              {browser ? (
                <>
                  GitHub sign-in isn't set up on this server. To try Tandem locally, sign in with the GitHub CLI (<code>gh auth login</code>) and
                  reload, or run the local helper.
                </>
              ) : (
                <>
                  Sign in with the GitHub CLI first (<code>gh auth login</code>), or start Tandem with <code>TANDEM_GITHUB_CLIENT_ID</code> set to
                  an OAuth app that has device flow turned on.
                </>
              )}
            </p>
          )}
        </div>
      )}
      {error && <p className="callout callout--err">{error}</p>}
    </>
  );
}
