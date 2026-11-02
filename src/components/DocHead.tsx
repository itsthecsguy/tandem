import { ThemeMenu } from "./ThemeMenu";

/** The top of the site's plain text pages. */
export function DocHead() {
  return (
    <header className="doc__head">
      <a className="doc__brand" href="/">
        <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden>
          <rect x="2.5" y="8" width="12" height="16" rx="3.5" fill="currentColor" />
          <rect x="17.5" y="8" width="12" height="16" rx="3.5" fill="currentColor" opacity="0.45" />
        </svg>
        Tandem
      </a>
      <ThemeMenu />
    </header>
  );
}
