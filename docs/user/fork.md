# The get-aix/t3code fork

get-aix/t3code is a soft fork of [T3 Code](https://github.com/pingdotgg/t3code), created by
pingdotgg and distributed under the MIT License. It keeps everything T3 Code does and adds:

- [aix profiles](./aix-profiles.md): API-key profiles from [aix](https://github.com/get-aix/aix)
  become Claude Code, Codex, and OpenCode providers, with model details for every gateway model.
- [Personal and Work](./work-personal.md): every project has a scope, and the sidebar, model
  picker, Settings, and Usage page follow it.
- [Gateway budgets](./aix-budgets.md): dollar budgets, spend, and reset times for your gateway keys.
- Fork builds for Windows, macOS, Linux, Nix, and Android that update from fork releases.

The fork uses the same app name, `t3` and `t3code-desktop` commands, and data directory as
upstream T3 Code. Install it **instead of** T3 Code, not next to it.

## Install

Download from the fork's [latest release](https://github.com/get-aix/t3code/releases/latest):

| Platform              | File or command                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Windows x64           | `irm https://github.com/get-aix/t3code/releases/latest/download/install-windows.ps1 \| iex`      |
| macOS (Apple Silicon) | `curl -fsSL https://github.com/get-aix/t3code/releases/latest/download/install-macos.sh \| bash` |
| Linux x64             | `T3-Code-x86_64.AppImage` or `T3-Code-<version>-amd64.deb`                                       |
| Nix / NixOS           | `nix profile add 'github:get-aix/t3code/release'`                                                |
| Android               | `T3-Code-<version>.apk`                                                                          |

Notes per platform:

- **Windows.** Run the command in a normal PowerShell window, not as administrator. It checks the
  download's SHA-256 and installs **T3 Code** for your user, with no admin or SmartScreen prompt.
  Quit T3 Code first. Set `$env:T3CODE_VERSION = "<version>"` to install a specific release. The
  `T3-Code-<version>-x64.exe` download also works, but it is unsigned: SmartScreen asks you to
  choose **More info → Run anyway**, and a work PC may block it.
- **macOS.** Use the script. The app is not notarized, so Gatekeeper blocks a DMG or zip downloaded
  in a browser. The script checks the download's SHA-256 and installs **T3 Code** into
  `/Applications` (or `~/Applications`). Quit T3 Code first. Set `T3CODE_VERSION=<version>` to
  install a specific release.
- **Linux.** Make the AppImage executable with `chmod +x` and run it, or install the `.deb` with
  `sudo apt install ./T3-Code-<version>-amd64.deb`.
- **Nix.** The flake builds from source for `x86_64-linux`. See
  [T3 Code fork (Nix)](./install.md#t3-code-fork-nix) for flake inputs, NixOS, Home Manager, and
  pinning a release.
- **Android.** See [The Android app](#the-android-app).

After installing, set up providers as described in [Install T3 Code](./install.md#providers).

### Switch over from T3 Code

Your threads, projects, and settings carry over, because the fork uses the same data directory.

1. Quit T3 Code.
2. Make a copy of your T3 data directory (`~/.t3` by default). Newer versions migrate the database,
   and installing an older build does not undo that.
3. Uninstall upstream T3 Code, or remove its Nix package.
4. Install the fork as above and start it.

Projects start in the Personal scope. Move your work projects to Work as described in
[Personal and Work](./work-personal.md#move-a-project).

To go back to upstream T3 Code, uninstall the fork and install upstream the same way. Upstream
doesn't know aix profiles or scopes, so aix providers stop working and all projects show together.
Your own provider sign-ins keep working.

## Updates

The desktop apps on Windows, macOS, and Linux update themselves from fork releases through the
in-app updater, the same way T3 Code does. Nix installs update through Nix: run
`nix profile upgrade` or `nix flake update t3code`, then rebuild. Install new Android APKs from the
Releases page.

Don't install upstream T3 Code or its Nix package over the fork. It would replace the fork and stop
its updates.

### Versions

Fork releases keep upstream's version numbers. `v0.1.10` is upstream T3 Code 0.1.10 with the fork's
changes on top.

Fixes the fork ships between upstream releases are numbered `X.Y.(Z+1)-aix.N`. For example,
`0.1.11-aix.1` is the first fork fix after 0.1.10. Installed apps update to it, then to upstream
0.1.11 when it ships.

The fork follows upstream's stable releases only. When upstream publishes one, the fork opens a
sync pull request, runs its full CI, and releases after it merges. Upstream's prereleases and
unreleased `main` never reach the fork.

## The Android app

The fork's APK is the official T3 Code Android app with the fork's changes: the Personal/Work
switch, scope-aware model picker, and model details. Its launcher label is **T3 Code**.

It uses the official package ID `com.t3tools.t3code` so T3 Connect sign-in works. That means it
replaces the Play Store app:

1. Uninstall T3 Code from the Play Store.
2. Download `T3-Code-<version>.apk` from the fork's Releases page and open it. Allow installing from
   your browser when Android asks.
3. Update only from fork releases. The Play Store can't update this app.

There is no fork iOS app. The App Store app connects to a fork server and runs aix providers like
any other provider, without the Work/Personal switch or model details.

## Use the fork with other clients

A fork server works with any T3 Code client: the fork's desktop and web apps, app.t3.codes, and the
official phone apps. aix providers show up in all of them. Only fork clients show the
Personal/Work switch and model details.

One client can also connect to both an upstream T3 server and a fork server. See
[remote access](./remote-access.md) for pairing and connecting.

## What this fork changes

Compared with upstream T3 Code:

- **aix profiles.** API-key profiles become Codex, Claude Code, and OpenCode providers, turned on
  with `T3CODE_AIX=1` (on by default in the desktop app and Nix package).
  See [aix profiles](./aix-profiles.md).
- **Model details.** Family, context window, max output, prices, and reasoning levels for gateway
  models. Catalogs refresh daily and on demand, with a stale warning when a refresh fails.
- **Personal and Work scopes.** Projects carry a scope that the sidebar, search, model picker,
  Settings → Providers, Project settings, and the command palette follow, on web, desktop, and
  Android. See [Personal and Work](./work-personal.md).
- **Gateway budgets.** The Usage page and the composer's usage-limits banner show aix key budgets,
  grouped by gateway project. See [Gateway budgets](./aix-budgets.md).
- **Usage by scope.** The Usage page counts Codex and Claude records for Work projects under Work.
- **Fork builds.** Windows, Apple Silicon macOS, Linux AppImage and `.deb`, a Nix flake, and an
  Android APK that replaces the Play Store app. Desktop apps update from fork releases.
- **Stable-only upstream sync.** The fork takes upstream's stable release tags, never its `main`.

Everything else, including providers, threads, worktrees, checkpoints, remote access, and T3
Connect, works as described in the [T3 Code guides](../README.md#using-t3-code).

## Run from source

Install [vp](../operations/development.md#first-checkout), then:

```sh
git clone https://github.com/get-aix/t3code.git
cd t3code
vp i
T3CODE_AIX=1 vp run dev
```

Open the address printed at startup. `main` includes unreleased fork changes.

Give every independent T3 server its own `T3CODE_HOME`, including an upstream T3 server on the same
machine. For NixOS, see the [pinned development shell](../operations/devenv.md).

To update a clean checkout:

```sh
git pull --ff-only origin main
vp i
```

Then restart with the same `T3CODE_HOME`. Copy that directory before upgrading: checking out older
source does not roll back database migrations. To go back to a known-good revision, stop the
server, run `git switch --detach <commit>`, then `vp i` and restart.

## Help

- [aix profiles: troubleshooting](./aix-profiles.md#troubleshooting)
- [Remote access](./remote-access.md) and [T3 Connect troubleshooting](./t3-connect-troubleshooting.md)
- Anything that isn't fork-specific: the [T3 Code guides](../README.md#using-t3-code)
