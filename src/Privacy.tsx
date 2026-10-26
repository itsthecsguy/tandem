// tandemkb.com/privacy. Plain text about what Tandem touches and where it goes,
// kept in step with src/engine/store.ts and worker/index.ts.

import { ThemeMenu } from "./components/ThemeMenu";

export function Privacy() {
  return (
    <div className="doc">
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

      <main className="doc__body">
        <h1>Privacy</h1>
        <p className="lede">
          Tandem runs in your browser. It has no accounts of its own, no database and no analytics. This page says what it touches and where
          that goes.
        </p>

        <h2>What stays in your browser</h2>
        <p>Tandem keeps these in your browser's storage for this site, and nowhere else:</p>
        <ul>
          <li>Your GitHub sign-in: the token, and the refresh token that renews it.</li>
          <li>The repo and branch you picked, and your build settings.</li>
          <li>Firmware it downloaded, so going back to a build skips GitHub.</li>
          <li>
            Notes about your keyboard: which halves' update ports this browser has used, the last build sent to the right half, and the
            ADV360PRO drive if you chose it.
          </li>
        </ul>
        <p>Signing out removes the GitHub tokens. Clearing this site's data in your browser removes all of it.</p>

        <h2>What goes to GitHub</h2>
        <p>
          Your browser talks to GitHub's API directly, with your token. Tandem asks for two permissions: <code>public_repo</code>, or{" "}
          <code>repo</code> if you allow private repos, and <code>workflow</code>. It uses them to read and commit to the repo you picked,
          create a repo when you ask for one, start your firmware build and download what it built. GitHub also serves the profile pictures
          on the page.
        </p>
        <p>
          To take Tandem's access away, revoke it on GitHub under Settings, Applications, Authorized OAuth Apps.
        </p>

        <h2>What goes through tandemkb.com</h2>
        <p>
          Cloudflare hosts the site. Its one piece of server code finishes GitHub sign-in, because that step needs the site's GitHub secret
          and GitHub doesn't let browsers do it. When you sign in, and when your token renews, your browser sends a one-time code or the
          refresh token to the site, which passes it on to GitHub with the secret and hands back GitHub's answer. That code keeps nothing and
          writes no logs. Cloudflare sees the usual details of each request, like your IP address, as any web host does.
        </p>

        <h2>Your keyboard</h2>
        <p>
          Tandem talks to your keyboard over Web Serial, between your browser and the USB cable. Nothing about the keyboard leaves your
          computer. The firmware it sends comes from your own repo's builds on GitHub.
        </p>

        <h2>Not affiliated with Kinesis</h2>
        <p>
          Tandem is an independent, open-source project. Kinesis Corporation doesn't make, endorse or support it. Kinesis and Advantage360
          are trademarks of Kinesis Corporation.
        </p>

        <p className="doc__foot">
          The source is at{" "}
          <a href="https://github.com/itsthecsguy/tandem" target="_blank" rel="noreferrer">
            github.com/itsthecsguy/tandem
          </a>
          , and questions go to its issues. Last changed October 26, 2026.
        </p>
      </main>
    </div>
  );
}
