import { useState } from "react";

import { releasesSince } from "../../shared/changelog";

/** What a repo on release `from` would get from an update, behind a link. */
export function WhatsNew({ from }: { from: number | null }) {
  const [open, setOpen] = useState(false);
  const releases = releasesSince(from);
  if (!releases.length) return null;
  return (
    <>
      <button type="button" className="link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Hide what's new" : "What's new"}
      </button>
      {open && (
        <div className="whats-new">
          {releases.map((release) => (
            <div key={release.version}>
              <strong>
                Tandem {release.version}: {release.title}
              </strong>
              <ul>
                {release.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </div>
          ))}
          <a href="/changelog" target="_blank" rel="noreferrer">
            All releases
          </a>
        </div>
      )}
    </>
  );
}
