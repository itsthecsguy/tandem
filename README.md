# Tandem

Edit your Kinesis Advantage 360 Pro layout, build its firmware in your own GitHub Actions, and put it on both halves from your browser. After a one-time setup, an update is: plug in both halves, click Update.

Tandem runs in the browser tab. Your layout lives in a GitHub repo you own, GitHub builds the firmware, and Chrome or Edge copies it onto the keyboard over USB. The site's only server code is a small Cloudflare Worker that finishes GitHub sign-in.

This is a prototype.

## Use it

1. Open [tandemkb.com](https://tandemkb.com) in Chrome or Edge on a computer.
2. Sign in with GitHub. Tandem asks for your public repos and their workflows, and for private repos only if you want one.
3. Plug in both halves and let the browser open their ports.
4. Choose where your layout lives:
   - **A repo you have**, such as your fork of Kinesis's config. Tandem adds itself with one commit and keeps your keys as they are.
   - **A new repo.** Tandem creates one on your account from its [config template](https://github.com/itsthecsguy/tandem-config), starting from Kinesis's default layout or the one on your keyboard. It can be private.
5. Run the one-time setup. GitHub builds the firmware. Then for the right half, and after it the left half, you press two keys and pick ADV360PRO in Chrome's list, and Tandem sends that half its firmware. Last, you pick each half's new Tandem port in Chrome's list, once per half. Tandem shows each step when it's time and names the entry to pick. After that, an update is one click: the halves restart into update mode by themselves and Tandem sends the firmware over serial, with nothing to press or pick.

Safari and Firefox can't talk to the keyboard. They can still edit the layout and build firmware, and an update ends with both files to copy onto the halves by hand.

## How an update runs

1. **Commit.** Saving commits the keymap to your branch through GitHub's API. If the branch changed on GitHub since Tandem loaded it, Tandem reloads instead of overwriting. Layers you didn't edit keep their spacing.
2. **Build.** The push starts your workflow. Tandem follows the job for the firmware it wants (Clique or plain) and downloads its artifact. Downloads are kept in the browser, so going back to a build skips GitHub. If a commit's push started no build, as with a repo just made from the template, Tandem starts one.
3. **Restart.** Right half first, then left. A half running Tandem firmware restarts into update mode when Tandem opens its serial port at 1200 baud. A half on other firmware needs its key combo, which Tandem shows on your layout. Both halves look the same in update mode, so when a combo lands on the other half, Tandem notices, updates that half first, and asks for the first one again. It tells by which half went quiet: the other one, or not the one it asked for. That needs the left half visible beforehand, through its ZMK Studio port on stock firmware, which is why setup asks to connect it first. A half on its first Tandem firmware comes back with a port Chrome hasn't allowed yet, and Tandem asks for those at the end, after both halves are flashed. If a half can't be seen but the other one runs Tandem firmware, Tandem first asks you to allow its port, since that's one click and no keys.
4. **Send.** In update mode, the half's bootloader opens a serial port of its own, listed as ADV360PRO. Tandem sends the firmware over it with the serial DFU protocol that Adafruit's nRF52 bootloader speaks, the same as `adafruit-nrfutil dfu serial`. Chrome asks once per half before a page may open that port, and remembers. If you'd rather not, or sending fails, the half's ADV360PRO drive works too: you choose it in the folder picker and Tandem copies the UF2 file.
5. **Check.** Each half restarts and must report the new build. A half that just got Tandem firmware has a new serial port, so the browser asks you to allow it once.

## What it adds to your keyboard

**Hold for layer or modifier, tap twice to repeat.** Tap a key and it sends the key. Hold it and it switches layer, or acts as a modifier. Tap it and then press and hold, and the key repeats. These are two ZMK hold-tap behaviors, `&ltr` and `&mtr`, that Tandem keeps in a marked block of your keymap. You can put them on any key.

**Updates without key presses.** The firmware module adds a small USB serial port to each half. Opening it at 1200 baud restarts that half into its UF2 bootloader, the same thing `&bootloader` does. Writing `info` returns one JSON line with the half's role, build ID and repo. Writing `keymap` returns the keymap file the firmware was built from, which the module embeds at build time.

The commit that adds Tandem to an existing repo changes:

- `tandem/zmk-tandem/`: the firmware module
- `.github/workflows/build.yml`: every `west build` includes the module, tagged with the commit's short SHA and the repo's name. A newer Tandem replaces an older version of these changes instead of adding a second copy.
- `config/adv360.keymap`: Tandem's repeat behaviors, plus any keys that already repeat on tap-then-hold switched over to them

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

In dev, `?demo=walkthrough` plays a first-time setup from stock firmware that you click through, with no keyboard or GitHub involved. Add `&wrong=half` to have the first key combo land on the other half, or `&wrong=port` to have the first port pick be the wrong one. `?demo=intro` shows the setup screen before it starts. `?demo=` with `setup`, `firsttime`, `sending`, `port`, `portleft`, `retry`, `switched`, `auto`, `updateport`, `drive`, `byhand` or `done` freezes the update sheet at one moment, and `repo` or `install` shows onboarding screens. Demo mode never sends changes. See `src/lib/demo.ts`.

## Deploy

The site is the `dist/` build served by the Worker in `worker/`, on Cloudflare's free tier.

1. Register the domain and add it to Cloudflare.
2. Create a GitHub OAuth app with the callback URL `https://tandemkb.com/auth/callback`. Put its client ID in `wrangler.toml` as `GITHUB_CLIENT_ID`.
3. Run `npx wrangler secret put GITHUB_CLIENT_SECRET` and paste the app's client secret.
4. Run `npm run build && npx wrangler deploy`, then add `tandemkb.com` as the Worker's custom domain in Cloudflare.

The Worker only trades codes for its own origin and callback URL, keeps no tokens, and serves the site with a content security policy that allows scripts from the site alone.

To update the config template, edit `template/` and run `scripts/publish-template.sh`, which commits it to [itsthecsguy/tandem-config](https://github.com/itsthecsguy/tandem-config).

## What's in this repo

- `src/` the UI, and `src/engine/` the browser engine: GitHub, builds, Web Serial and flashing
- `shared/` code the browser and the helper share: keymap files, layout, setup, Studio translation and the GitHub client
- `worker/` the Cloudflare Worker that serves the site and finishes sign-in
- `template/` the config template: Kinesis's config at V3.0 with the default layout, the build workflow with Tandem added, and `tandem/zmk-tandem/`, the firmware module
- `helper/` the optional local helper
- `test/` tests, with the fake GitHub and keyboard in `test/fakes/`

## Next

- **Narrower access.** A GitHub App could be limited to the user's one config repo, instead of an OAuth app that can see all of them.
- **Module.** Publish `zmk-tandem` as its own repo and reference it from `west.yml`, so updating it is a one-line change.
- **Faster builds.** A prebuilt image with ZMK and the toolchain inside skips fetching ZMK on every run.

## License

MIT. Kinesis's config files keep their copyright, and files from ZMK keep the license in their headers.
