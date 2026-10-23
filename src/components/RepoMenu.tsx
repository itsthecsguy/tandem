import { ArrowUpRight, ChevronDown, LogOut, Repeat, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { RepoRef } from "../../shared/types";
import { GitHubMark } from "./GitHubMark";

interface Props {
  repo: RepoRef & { url: string };
  login: string | null;
  onChangeRepo: () => void;
  onRestartSetup: () => void;
  onSignOut: () => void;
}

export function RepoMenu({ repo, login, onChangeRepo, onRestartSetup, onSignOut }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="repo-menu" ref={root}>
      <button type="button" className="repo-chip" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <GitHubMark size={14} />
        <span className="repo-chip__name">{repo.name}</span>
        <span className="repo-chip__branch">{repo.branch}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu__head">
            {repo.owner}/{repo.name}
            {login && <small>Signed in as @{login}</small>}
          </div>
          <a className="menu__item" role="menuitem" href={repo.url} target="_blank" rel="noreferrer">
            <ArrowUpRight size={15} /> Open on GitHub
          </a>
          <button type="button" className="menu__item" role="menuitem" onClick={onChangeRepo}>
            <Repeat size={15} /> Change repo or branch
          </button>
          <button type="button" className="menu__item" role="menuitem" onClick={onRestartSetup}>
            <RotateCcw size={15} /> Run setup again
          </button>
          <button type="button" className="menu__item" role="menuitem" onClick={onSignOut}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
