# Run a local fork build beside the official app

`vp run fork:install` builds this checkout's Linux x64 AppImage and installs it as
**T3 Code Fork**. The fork runs at the same time as an official install, such as the nightly,
and shares none of its state.

The build version is the switch. `scripts/fork-install.ts` stamps a version of the form
`<release>-fork.<yyyymmdd>.g<commit>`, with `.dirty` added for uncommitted changes. Any
version in that form gets the identity in `packages/shared/src/desktopFork.ts`. Other
versions build and run exactly as upstream.

## Install or update the fork

1. From the repository root, run the installer. Without `vp` on your `PATH`, use
   `pnpm run fork:install`.

   ```sh
   vp run fork:install
   ```

2. Restart **T3 Code Fork** from the launcher, or run `~/.local/bin/t3-code-fork`.

A running fork keeps working while a new version installs, and the installer does not prune a
version that is running. It refuses only to rebuild the exact version that is running.

Run the same command after each pull or rebase. If the commit is already installed and the
tree is clean, the installer skips the build and only refreshes the launcher and desktop
entry. To build again anyway, add `--rebuild`. To see the full build output, add `--verbose`.

The build needs the Linux desktop build tools: `cargo`, `cc`, `make`, `pkg-config` with
`libsecret`, and ImageMagick. It needs no release secrets. It stages files under
`~/.cache/t3-code-fork` instead of `/tmp`, and deletes them when it finishes.

## Where the fork keeps its data

- The app is in `~/.local/opt/t3-code-fork/<version>/`. The installer keeps the current
  version and the most recently installed other version, and deletes older ones.
- The launcher is `~/.local/bin/t3-code-fork`, a link to the current version's `AppRun`.
- The desktop entry is `~/.local/share/applications/t3-code-fork.desktop`. Under Wayland the
  fork's window app id is `t3-code-fork`, which matches the entry. Under X11 its window class
  is `t3code-fork`.
- The T3 home is `~/.t3-fork`. The fork sets `T3CODE_HOME` to it for its server, its
  terminals, and its `t3` launcher, even when `T3CODE_HOME` is already set.
- The Electron profile is `~/.config/t3code-fork`. The single-instance lock lives there, so
  the fork and the official app never hand launches to each other.

The fork does not register a handler for `t3code://` links, so those links keep opening the
official app. Sign-in flows that return through such a link do not reach the fork. The fork
has no update feed and turns off automatic updates and telemetry.

## Seed the fork from your real data

On the first install only, when `~/.t3-fork/userdata` does not exist, the installer seeds it.
It runs `apps/server/scripts/migrate-dev-db.ts` against a read-only snapshot of
`~/.t3/userdata/statev2.sqlite`. The snapshot keeps recent projects and their stopped
threads. It drops scheduled tasks, pending work, and auth sessions. The installer also copies
`settings.json` and `keybindings.json` if they exist. It never writes to `~/.t3`.

To seed more history, pass `--seed-projects` and `--seed-threads-per-project`. These flags
only apply when the installer seeds a new fork home.

Seeded threads keep their original project folders and worktree paths. Continuing a seeded
thread in the fork runs its agent in that folder.

## Reset the fork

1. Quit T3 Code Fork.
2. Delete the fork's state:

   ```sh
   rm -rf ~/.t3-fork ~/.config/t3code-fork
   ```

3. Run `vp run fork:install` again. It seeds a new fork home.

To remove the fork completely, also delete `~/.local/opt/t3-code-fork`,
`~/.local/bin/t3-code-fork`, and `~/.local/share/applications/t3-code-fork.desktop`.
