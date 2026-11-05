# Tandem

Edit your Kinesis Advantage 360 Pro layout, build its firmware in your own GitHub Actions, and put it on both halves from your browser. After a one-time setup, an update is: plug in both halves, click Update.

Tandem runs in the browser tab. Your layout lives in a GitHub repo you own, GitHub builds the firmware, and Chrome or Edge copies it onto the keyboard over USB. The site's only server code is a small Cloudflare Worker that finishes GitHub sign-in.

This is a prototype. It's an independent project, not made or endorsed by Kinesis Corporation.

## Use it

1. Open [tandemkb.com](https://tandemkb.com) in Chrome or Edge on a computer.
2. Sign in with GitHub. Tandem asks for your public repos and their workflows, and for private repos only if you want one.
3. Plug in both halves and let the browser open their ports.
4. Choose where your layout lives:
   - **A repo you have**, such as your fork of Kinesis's config. Tandem adds itself with one commit and keeps your keys as they are.
   - **A new repo.** Tandem creates one on your account from its [config template](https://github.com/itsthecsguy/tandem-config), starting from Kinesis's default layout or the one on your keyboard. It can be private.
5. Run the one-time setup. Start setup opens Chrome's list for the left half's update port right away, since Chrome only opens it from a click and adds ADV360PRO to it once the half is in update mode. So while GitHub builds the firmware, you press two keys on the left half and pick ADV360PRO, and Tandem sends that half its firmware once the build is done. The left half's new firmware restarts the right half for you, so for the right half you only pick its ADV360PRO. After that, an update is one click: the halves restart into update mode by themselves and Tandem sends the firmware over serial, with nothing to press or pick. Chrome remembers each half's update port per browser profile, and the port only exists while the half is in update mode, so a browser that didn't do the setup, such as another computer or a new Incognito window, gets a one-minute "Trust this browser" step in onboarding: Tandem restarts each half, you connect its ADV360PRO, and it sends back the build it already runs.

Safari and Firefox can't talk to the keyboard. They can still edit the layout and build firmware, and an update ends with both files to copy onto the halves by hand.

## Privacy

Tandem has no accounts of its own, no database and no analytics. The GitHub token, the repo you picked and downloaded firmware stay in your browser's storage for the site. Your browser talks to GitHub's API and to the keyboard directly. The only thing that passes through the site's Worker is the sign-in code, or the refresh token when the GitHub token renews, which it hands to GitHub with the app's secret and doesn't keep. The full page is [tandemkb.com/privacy](https://tandemkb.com/privacy), from `src/Privacy.tsx`.

## How an update runs

1. **Commit.** Saving commits the keymap to your branch through GitHub's API. If the branch changed on GitHub since Tandem loaded it, Tandem reloads instead of overwriting. Layers you didn't edit keep their spacing. An update then commits any changes from Kinesis that Tandem has tested, and any newer Tandem, on top. See [Staying up to date](#staying-up-to-date).
2. **Build.** The push starts your workflow. Tandem follows the job for the firmware it wants (Clique or plain) and downloads its artifact. Downloads are kept in the browser, so going back to a build skips GitHub. If a commit's push started no build, as with a repo just made from the template, Tandem starts one.
3. **Restart.** A half running Tandem firmware restarts into update mode when Tandem opens its serial port at 1200 baud. The right half needs no port of its own: the left half, on Tandem protocol 3, restarts it over the split link when Tandem asks, whatever firmware the right half runs, as long as its keymap has `&bootloader`. So an update goes right half first, through the left half, then the left half. During setup, when the left half doesn't run Tandem firmware yet, it goes first by its key combo, which Tandem shows on your layout, and its new firmware then restarts the right half. Both halves look the same in update mode, so when a combo lands on the other half, Tandem notices, updates that half first, and asks for the first one again. It tells by which half went quiet: the other one, or not the one it asked for. That needs the left half visible beforehand, through its ZMK Studio port on stock firmware, which is why setup asks to connect it first. On a Mac, Chrome then trusts the left half's new Tandem port too. Elsewhere it asks for it once.
4. **Send.** In update mode, the half's bootloader opens a serial port of its own, listed as ADV360PRO. Tandem waits a few seconds for the half's drive to mount, since a transfer that starts sooner stalls the bootloader, then sends the firmware over it with the serial DFU protocol that Adafruit's nRF52 bootloader speaks, the same as `adafruit-nrfutil dfu serial`. Chrome asks once per half before a page may open that port, and remembers. If you'd rather not, or sending fails, the half's ADV360PRO drive works too: you choose it in the folder picker and Tandem copies the UF2 file.
5. **Check.** The left half restarts and must report the new build. The right half must reconnect to the left half, which says so. Its bootloader checked the image before starting it.

## What it adds to your keyboard

**Hold for layer or modifier, tap twice to repeat.** Tap a key and it sends the key. Hold it and it switches layer, or acts as a modifier. Tap it and then press and hold, and the key repeats. These are two ZMK hold-tap behaviors, `&ltr` and `&mtr`, that Tandem keeps in a marked block of your keymap. You can put them on any key.

**Updates without key presses.** The firmware module adds a small USB serial port to each half. Opening it at 1200 baud restarts that half into its UF2 bootloader, the same thing `&bootloader` does. Writing `info` returns one JSON line with the half's role, build ID, repo and Tandem release. Writing `keymap` returns the keymap file the firmware was built from, which the module embeds at build time. On the left half, `info` also says whether the right half is connected, and writing `boot right` makes the left half run `&bootloader` on the right half over the split link, so Tandem never needs a port of the right half's own.

**Every paired computer reconnects.** ZMK advertises only while the active profile's computer is away. Pair a laptop on profile 1 and a tablet on profile 2, switch to the tablet, and the laptop can't reconnect after it drops, say when you carry it out of range, until you switch back. At boot, whichever connects first can lock the other out the same way. ZMK also gives up if the radio refuses to start advertising. So the left half checks every 5 seconds, and right after a computer disconnects or you switch profiles, and advertises whenever a paired computer is away. For the first 30 seconds it advertises as fast as ZMK does, every 100 to 150 ms, so a short drop comes back in about a second. After that it advertises about once a second, a tenth as often, and a computer coming back takes a few seconds to reconnect. That computer gets no keys until you switch to its profile, and switching makes ZMK advertise fast again, so the wait doesn't show.

The commit that adds Tandem to an existing repo changes:

- `tandem/zmk-tandem/`: the firmware module
- `.github/workflows/build.yml`: every `west build` includes the module, tagged with the commit's short SHA and the repo's name, in the build image Tandem tested. A newer Tandem replaces an older version of these changes instead of adding a second copy.
- `config/west.yml`: the ZMK and Zephyr commits Tandem tested, instead of the branches Kinesis follows, and only the modules the firmware builds from
- `config/adv360.keymap`: Tandem's repeat behaviors, plus any keys that already repeat on tap-then-hold switched over to them

## Staying up to date

Kinesis's config follows a branch of ZMK and a Docker tag, so one commit can build different firmware from one day to the next. Tandem pins all of it in [`shared/pins.json`](shared/pins.json): Kinesis's config, its ZMK, that ZMK's Zephyr, and the build image. A release moves a pin only after testing it, and a scheduled workflow opens an issue here when anything upstream moves. A bad commit upstream can't reach anyone by itself.

**Tandem's own changes.** When the site has a newer release than your repo, the next keyboard update commits it on top of your layout before it builds. The banner says what's in it, and so does [tandemkb.com/changelog](https://tandemkb.com/changelog). The halves report their release in the `info` command's answer.

**Kinesis's changes.** A keyboard update also brings in anything between Kinesis's commit your repo last had and the one Tandem tested. This goes file by file, on forks and on repos from the template alike, because a repo from the template shares no history with Kinesis's, and GitHub's own fork sync would conflict with Tandem's edits to the workflow and the manifest:

- A file you didn't change takes Kinesis's version.
- A file you changed elsewhere gets a three-way merge, as in git.
- The workflow and manifest have Tandem's edits taken out, get merged, and have them put back.
- Your layout is yours. Kinesis's default only replaces a layout nobody changed.
- When a change overlaps yours in a file the firmware builds from, Tandem commits none of it and says which file. Your updates keep working without Kinesis's changes until you merge that file by hand.

On a fork, the commit has Kinesis's commit as a second parent, so GitHub stops counting the fork as behind. A repo from the template records the commit in `tandem/kinesis-base`.

## Going back

**Versions and undo**, in the repo menu, has three ways back:

- **Put a kept build back.** The browser keeps the last few builds. This puts one on the keyboard without touching your repo, so the next keyboard update goes back to your latest commit.
- **Undo an update.** Tandem commits the reverse of one of its own commits, keeping any layout saves you made since, and records the release in `tandem/hold.json` so later updates leave it out until a newer one comes. If a build of Tandem's commit fails, the update offers this right there.
- **Leave Tandem.** Tandem takes itself out of your repo, GitHub builds Kinesis's firmware with your layout, and Tandem puts it on both halves. The sheet then says how to clear saved settings too, if you want that.

## Trying ZMK 4.1

[Kinesis issue #860](https://github.com/KinesisCorporation/Adv360-Pro-ZMK/issues/860) is a community port of Kinesis's firmware to ZMK on Zephyr 4.1. Tandem can put it on a branch of its own, `tandem-zmk-4.1`, leaving your branch as it was, so going back is one click and an update. It's in **Versions and undo** when the page's URL has `?beta`. Nobody has run Tandem's parts of it on a keyboard yet.

## Reading the layout from the keyboard

Starting a new repo can use the layout that's on the keyboard now, so people who customized it with Kinesis's Clique app, and never had a repo, keep it.

- **Tandem firmware** answers a `keymap` command with the exact keymap file it was built from.
- **Other ZMK firmware** with ZMK Studio, which Kinesis's Clique build has, is read over Studio's protocol. Studio keeps the keymap locked, so Tandem asks you to press the unlock key, Mod + Esc on Kinesis's default layout. Tandem then translates each binding back into keymap syntax and lists any it couldn't translate.

## The local helper

`helper/` is an optional program for macOS that does the same work from your computer instead of the tab. It finds the halves over USB without asking for ports, copies firmware without the folder picker, and works with any browser. It signs in with the GitHub CLI (`gh auth login`), or with GitHub's device flow when `TANDEM_GITHUB_CLIENT_ID` names an OAuth app that has it turned on.

```bash
npm install
npm --prefix helper install
npm run helper
```

Then open http://localhost:4317. The helper serves the same UI, which sees the helper and uses it. It keeps its state in `~/Library/Application Support/Tandem`, or in `TANDEM_HOME` if you set it.

## Develop

```bash
npm install
npm run dev
```

Then open http://localhost:5317. Without the Worker there's no GitHub sign-in, so the dev server lets the page use the GitHub CLI's login instead. `npm run dev:helper` runs the UI against the helper.

To run the site the way it's deployed, with the Worker and real GitHub sign-in, create a GitHub OAuth app whose callback URL is `http://127.0.0.1:8787/auth/callback`, copy `.dev.vars.example` to `.dev.vars` with its client ID and secret, then:

```bash
npm run site
```

and open http://127.0.0.1:8787.

```bash
npm test
npm run typecheck
npm --prefix helper run typecheck
```

The tests run the browser engine against an in-memory GitHub and a simulated keyboard, so they cover updates end to end.

In dev, `?demo=walkthrough` plays a first-time setup from stock firmware that you click through, with no keyboard or GitHub involved. Add `&wrong=half` to have the first key combo land on the other half, or `&wrong=port` to have the first port pick be the wrong one. `?demo=intro` shows the setup screen before it starts, and `?demo=trust` the step for a browser that hasn't updated the keyboard yet. `?demo=` with `setup`, `firsttime`, `sending`, `port`, `portleft`, `retry`, `switched`, `auto`, `updateport`, `drive`, `byhand`, `done`, `buildfailed`, `rollback` or `left` freezes the update sheet at one moment, `repo` or `install` shows onboarding screens, `outdated` or `held` shows the update banners, and `history` shows Versions and undo. Demo mode never sends changes. See `src/lib/demo.ts`.

## Deploy

The site is the `dist/` build served by the Worker in `worker/`, on Cloudflare's free tier.

1. Register the domain and add it to Cloudflare.
2. Create a GitHub OAuth app with the callback URL `https://tandemkb.com/auth/callback`. Put its client ID in `wrangler.toml` as `GITHUB_CLIENT_ID`.
3. Run `npx wrangler secret put GITHUB_CLIENT_SECRET` and paste the app's client secret.
4. Run `npx wrangler login` once, then `npm run build && npx wrangler deploy`. `wrangler.toml` makes `tandemkb.com` the Worker's custom domain, so Cloudflare sets up its DNS record and certificate.

The Worker only runs for `/api/*`: it trades codes for its own origin and callback URL, and keeps no tokens. Cloudflare serves the pages and files straight from `dist/`, which is free and unlimited on its free plan, with the headers in `public/_headers`: a content security policy that allows scripts from the site alone and blocks framing, HSTS, and a cross-origin opener policy. On the free plan, the Worker's share is 100,000 requests a day, and only sign-ins count toward it.

## Release

Keyboard updates commit whatever the site bundles into every user's repo, so a release goes through a gate, `npm run release`. Push the commit first. The script stops at the first thing that fails:

1. The tests, the type checks and a build of the site.
2. `npm run e2e`, which runs Tandem's engine against the real GitHub with the GitHub CLI's login. It brings a repo on an older Kinesis config up to date, undoes that, leaves Tandem, makes the ZMK 4.1 trial branch, and syncs a fork with a merge commit. It keeps two throwaway repos, `tandem-e2e` and `tandem-e2e-fork`, makes them on its first run and deletes its branches after each run. Actions stay off in both, so nothing builds.
3. CI on that commit, including the Firmware workflow. It builds the template's firmware the way a user's repo does, checks that both halves report the new release, and builds the ZMK 4.1 trial the way Tandem makes one.
4. A check that a changed `template/` has a new number in `version.txt`.
5. `scripts/publish-template.sh`, which commits `template/` to [itsthecsguy/tandem-config](https://github.com/itsthecsguy/tandem-config), and then that repo's own firmware build, both variants.
6. `wrangler deploy`.

To take something upstream moved, follow the steps in the issue the Upstream workflow opens: move the pin in `shared/pins.json`, update `template/` to match, flash it to a keyboard, and add a release to `version.txt` and `shared/changelog.ts`.

## What's in this repo

- `src/` the UI, and `src/engine/` the browser engine: GitHub, builds, Web Serial and flashing
- `shared/` code the browser and the helper share: keymap files, layout, setup, syncing with Kinesis, undo, Studio translation and the GitHub client
- `worker/` the Cloudflare Worker that serves the site and finishes sign-in
- `template/` the config template: Kinesis's config at V3.0 with the default layout, the build workflow with Tandem added, and `tandem/zmk-tandem/`, the firmware module
- `helper/` the optional local helper
- `test/` tests, with the fake GitHub and keyboard in `test/fakes/`, and `test/e2e.test.ts` against the real GitHub
- `scripts/` the release gate, the firmware checks and the upstream watch

## Next

- **Narrower access.** A GitHub App could be limited to the user's one config repo, instead of an OAuth app that can see all of them.
- **Module.** Publish `zmk-tandem` as its own repo and reference it from `west.yml`, so updating it is a one-line change.
- **Faster builds.** A prebuilt image with ZMK and the toolchain inside skips fetching ZMK on every run.

## License

MIT. Kinesis's config files keep their copyright, and files from ZMK keep the license in their headers.
