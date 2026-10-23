# Tandem

Edit your Kinesis Advantage 360 Pro layout, build the firmware in your own GitHub Actions, and flash both halves. After a one-time setup, an update is: plug in both halves, click Update.

This repo holds two things. One is the Tandem app, which runs on your computer. The other is a ZMK config for the Advantage 360 Pro with Kinesis's default layout and Tandem already set up, so a copy of this repo builds Tandem firmware as soon as GitHub Actions runs.

This is a prototype. It has only been tried on macOS.

## Get started

1. Fork this repo. GitHub won't make a fork of a public repo private, so if you want your layout private, use **Use this template** and create a private repo instead.
2. If you forked, open your copy's Actions tab and turn workflows on. GitHub turns them off on new forks.
3. Clone your copy and start Tandem:

   ```bash
   git clone https://github.com/YOUR-NAME/tandem
   cd tandem
   npm install
   npm start
   ```

4. Open http://localhost:4317 and follow setup. When it asks where your layout lives, pick your copy. It's set up already, so Tandem goes straight to building firmware.

Already have a config repo, such as a fork of Kinesis's [Adv360-Pro-ZMK](https://github.com/KinesisCorporation/Adv360-Pro-ZMK)? Clone this repo without forking it, run it the same way, and pick your repo in setup. Tandem adds itself with one commit and keeps your keys as they are. If you have no repo, setup can also create one for you.

To get a newer Tandem into a fork, click **Sync fork** on GitHub, then `git pull`. The sync changes your firmware module too, so GitHub builds new firmware and Tandem offers to flash it. If Kinesis's default keymap changed upstream, the sync can conflict with your layout. Keep your version of `config/adv360.keymap`.

## First run

Setup is four full-screen steps.

1. **GitHub.** Tandem uses your GitHub CLI login (`gh auth login`), or GitHub's device flow when `TANDEM_GITHUB_CLIENT_ID` names an OAuth app with device flow turned on. It needs the `repo` and `workflow` scopes. For the CLI, add the second one with `gh auth refresh -s workflow`.
2. **Keyboard.** Plug in both halves. Tandem checks which firmware each half runs. If it's already Tandem firmware, setup skips the one-time flash, and newer Tandem firmware also names the repo it was built from so setup can offer that repo. You can also set up without the keyboard and flash later.
3. **Layout.** Choose where the layout lives:
   - **A repo you have**, such as your copy of this repo or your fork of Kinesis's config. If the repo doesn't have Tandem yet, Tandem makes one commit to the branch you pick and keeps your keymap's keys as they are.
   - **A new repo.** Tandem copies Kinesis's current config into a new repo on your account, with Tandem already added. It's a regular repo, not a fork, because GitHub allows one fork per repo network per account. You can start from Kinesis's default layout or from the layout on your keyboard.
4. **Firmware.** If the halves don't run Tandem firmware yet, Tandem builds it on GitHub and walks you through the key combo on each half, this one time. If they do, it offers a hands-free update when their build is behind the repo.

The commit that adds Tandem to a repo changes:

- `tandem/zmk-tandem/`: the firmware module (see below)
- `.github/workflows/build.yml`: every `west build` includes the module, tagged with the commit's short SHA and the repo's name. A newer Tandem replaces an older version of these changes instead of adding a second copy.
- `config/adv360.keymap`: Tandem's repeat behaviors, plus any keys that already repeat on tap-then-hold switched over to them

This repo's own config already has that commit applied. A test checks that it stays that way.

## Reading the layout from the keyboard

Starting a new repo can use the layout that's on the keyboard now, so people who customized it with Kinesis's Clique app, and never had a repo, keep it.

- **Tandem firmware** (protocol 2) answers a `keymap` command with the exact keymap file it was built from.
- **Other ZMK firmware** with ZMK Studio, which is what Kinesis's Clique build has, is read over Studio's protocol. Studio keeps the keymap locked, so Tandem asks you to press the unlock key. On Kinesis's default layout that's Mod + Esc. Tandem then translates each binding back into keymap syntax and lists any it couldn't translate. The Studio client is bundled for Node with `npm run vendor`.

## How an update runs

1. **Commit.** Saving the layout commits `config/adv360.keymap` to your branch through the GitHub API. Your local clone isn't involved, so `git pull` before you commit anything yourself. If the branch changed on GitHub since Tandem loaded it, Tandem reloads instead of overwriting. Layers you didn't edit keep their spacing.
2. **Build.** The push starts your workflow. Tandem follows the job for the firmware it wants (Clique or plain), then downloads its artifact. Builds already downloaded are reused. In this repo, the workflow only runs when `config/`, `tandem/`, `bin/` or the workflow itself changes, so changes to the app don't build firmware.
3. **Flash.** Tandem finds both halves over USB. A half has the same USB serial number in its bootloader as in normal use, because both derive it from the chip ID, and that's how Tandem tells the two drives apart.
   - A half running Tandem firmware is told to restart into its bootloader.
   - A half on older firmware needs its key combo, and the app shows which keys to press. Combos only work while the other half is running, so those halves go one at a time.
4. **Check.** Each half restarts and reports its build ID, which must match the commit.

## What it adds to your keyboard

**Hold for layer or modifier, tap twice to repeat.** Tap a key and it sends the key. Hold it and it switches layer, or acts as a modifier. Tap it and then press and hold, and the key repeats. These are two ZMK hold-tap behaviors, `&ltr` and `&mtr`, that Tandem keeps in a marked block of your keymap. You can put them on any key.

**Updates without key presses.** The module adds a small USB serial port to each half. Opening it at 1200 baud reboots that half into its UF2 bootloader, the same thing `&bootloader` does. Writing `info` returns one JSON line with the half's role, build ID and repo. Writing `keymap` returns the keymap file the firmware was built from, which the module embeds at build time.

## What's in this repo

- `config/` Kinesis's config from [KinesisCorporation/Adv360-Pro-ZMK](https://github.com/KinesisCorporation/Adv360-Pro-ZMK) at V3.0, with the default layout. `config/adv360.keymap` is the file Tandem edits.
- `tandem/zmk-tandem/` the ZMK module. Setup copies it into other repos.
- `.github/workflows/build.yml` Kinesis's build workflow with Tandem added
- `bin/get_version.sh` and `settings-reset.uf2` from Kinesis. The workflow uses the script. Flashing the reset file to a half clears its saved settings, including Bluetooth pairings.
- `src/` web UI (React)
- `server/` local helper: GitHub, keymap files, USB detection, flashing
- `shared/` types, ZMK key codes and binding parsing
- `test/` keymap and workflow tests

Kinesis's local Docker build isn't here, since it would build firmware without Tandem. Their repo also has the [key position chart](https://github.com/KinesisCorporation/Adv360-Pro-ZMK/blob/V3.0/assets/key-positions.png) and docs on editing the keymap by hand.

## Development

```bash
npm run dev        # helper with reload, UI on http://localhost:5317
npm test
npm run typecheck
```

In dev, `?demo=setup`, `?demo=auto`, `?demo=done`, `?demo=repo` and `?demo=install` show screens without a keyboard. Demo mode never sends changes.

Tandem keeps its state, workspace and downloaded builds in `~/Library/Application Support/Tandem`. Set `TANDEM_HOME` to use another folder, for example to try setup from scratch without losing your own.

## From prototype to product

- **Sign-in.** Register a GitHub OAuth app with device flow turned on and ship its client ID. Device flow needs no client secret and no server.
- **Repo creation.** Setup's new repos copy Kinesis's config from GitHub at the moment they're made. Copying this repo's `config/` instead would start everyone from the version Tandem tests.
- **Module.** Publish `zmk-tandem` as its own repo and reference it from `west.yml`, so updating it is a one-line change.
- **Faster builds.** A prebuilt image with ZMK and the toolchain inside, published to GitHub's container registry, skips fetching ZMK on every run.
- **Packaging.** Wrap the UI and helper in Tauri and ship it through GitHub Releases. The helper has to stay local because copying firmware to the keyboard needs USB access.

## License

MIT. Kinesis's config files keep their copyright, and files from ZMK keep the license in their headers.
