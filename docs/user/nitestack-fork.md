# Nitestack/t3code fork

Nitestack/t3code is a soft fork of [T3 Code](https://github.com/pingdotgg/t3code), created by
pingdotgg and distributed under the MIT License. It keeps T3's providers, threads, and remote access,
and adds runtime support for [aix](https://github.com/Nitestack/aix) API-key profiles and
project-level Personal and Work scopes.

It uses the same T3 Code app name, `t3` and `t3code-desktop` commands, and default state directory
as upstream, so install it instead of upstream T3 Code, not next to it. Android is the exception:
its hidden package ID differs, so both Android apps can be installed.

## aix profiles

Configure aix itself with the [aix setup and profile guide](https://github.com/Nitestack/aix/blob/main/README.md).
To use its profiles in T3, start the fork's server with `aix` on its `PATH` and `T3CODE_AIX=1` in
its environment. Without that variable the server behaves like upstream T3, and instances it created
for aix earlier are disabled. Your own Codex, Claude, and other provider sign-ins are not changed.

T3 reads the profile list from aix and asks aix for each profile's endpoint and key inside the server
process. Keys are never written to T3 settings or sent to clients. ChatGPT sign-in profiles are not
supported; keep using the regular Codex provider for a ChatGPT subscription.

The model picker follows the selected project's scope. Personal projects show subscription
providers. Work projects show aix instances; choose a profile from the picker footer to see its
Codex, Claude Code, and OpenCode instances (for example, `adCare · Codex`). If a thread already
uses a model from the other scope, that selection stays visible until you choose another model.
A model's details show its family, context window, maximum output, input and output prices per
million tokens, and reasoning levels. Values the gateway does not report show as Unknown. The model
ID sent to the gateway is the original ID.

Each model runs in the agent that matches its family:

- A direct Anthropic API profile offers Claude models only.
- Claude models run in Claude Code, from a LiteLLM gateway or the Anthropic API.
- GPT models from a LiteLLM gateway run in Codex. Open-weight `gpt-oss` models run in OpenCode.
- Other chat models from a LiteLLM gateway run in OpenCode, which T3 configures for that profile. You
  do not need to install a provider login or write an OpenCode config for it.
- Embedding, image, audio, and generic wildcard routes are not listed.

If a selected model or profile stops working, the turn fails with an error. T3 never switches to a
different model or agent for you.

When a profile's LiteLLM key has a budget, the Usage page's Work tab shows one dollar Budget for
that profile, with its reset time when the gateway reports one. The composer usage-limits panel
separates Personal and Work limits. A key without a budget, or a direct Anthropic profile, shows
no budget.

### Refresh and key rotation

Profiles and model catalogs are loaded when the server starts and reloaded at most once a day.
Use the refresh button next to an aix profile in the model picker, or "Refresh aix catalogs" in the
command palette on web and desktop, to reload immediately, for example after adding a profile or
model in aix. If a reload fails, the picker keeps the last catalog and marks it stale. A
profile deleted in aix disables its instances; an instance you turn off yourself stays off when its
profile returns.

A rotated key is picked up the next time T3 starts an agent process for that profile. A running turn
keeps the process it started with.

### Switching profiles and models in a thread

Pick another aix model in a thread's model picker to change model or profile. T3 uses its existing
provider switch and [portable handoff](./portable-handoffs.md), so the next agent receives the
conversation as context; it does not continue the same native session. A selection made while a turn
is running applies from your next message; the running turn is not stopped. New threads start with
the project's last selection, like other providers.

## Work/Personal view

Projects have a Personal or Work scope. On web, desktop, and the fork's Android app, the sidebar
switch shows projects in the selected scope. Move a project from its sidebar menu, the command
palette, or Project settings; the move can be undone. New projects inherit the active scope when the
connected server supports project scopes. The model picker starts in the project's scope, and its
Personal/Work toggle can switch scopes while you choose a model. In Settings → Providers, use the
Personal/Work switch and Work profile menu to find provider instances.

The scope filters projects, threads, search, and related project choices. It does not stop running
turns or queued work, and notifications are not filtered by scope. The preference is saved per
client. Shared preferences such as theme and shortcuts stay shared.

Each project stores its scope on its server, and each client chooses which scope to show. The scope
does not provide access control or isolate server data.
For real separation, run separate T3 servers with their own data directories using `T3CODE_HOME` as
described in the [isolated Nix launch guide](./install.md#t3-code-fork-nix). One client can connect
to both an original T3 server and a fork server.

## Mobile apps

The Android app's launcher label is **T3 Code**. It uses the official package ID `com.t3tools.t3code` so T3 Connect sign-in
works, which means it replaces the Play Store app: uninstall that first, then update only from fork releases. When a stable release is published, its signed
APK appears with its SHA-256 checksum and build metadata; there is no store listing. Its `vX.Y.Z` tag points to the fork
integration merge commit on `main`, whose tree contains fork changes and upstream through the
matching stable tag. The upstream tag commit is recorded only as the stable base. The release
workflow also builds a Windows x64 installer and the matching Nix package. Windows signing status is recorded in
the artifact metadata; current fork builds are expected to be unsigned. Before public publication,
the Windows installer and APK can be downloaded from the build-only Actions artifact described in
the [install guide](./install.md#t3-code-fork-windows-and-android). See the
[Android build guide](../operations/android-fork-apk.md).

The official Android and iOS apps are unchanged upstream clients. aix profiles reach them as regular
provider instances with standard model choices, and the upstream web client was verified against a
fork server. The official phone apps have not yet been run against a fork server. They do not show the
Work/Personal switch or the extra model details; use their existing environment selection instead.
There is no fork iOS app.

## What this fork changes

Compared with upstream T3 Code at
[`f82162f033`](https://github.com/pingdotgg/t3code/commit/f82162f0336c226ae1f2927f781a0fb660869a51):

- aix API-key profiles as provider instances for Codex, Claude Code, and a T3-managed OpenCode,
  enabled with `T3CODE_AIX=1`.
- Model details for aix models: family, context window, prices, reasoning levels, refresh, and a
  stale-catalog warning.
- The Usage page's Work tab includes Work-scoped Codex records and Claude sessions matched to aix
  profile instances, along with aix budgets, cost, and tokens.
- Project-level Personal/Work scopes on web, desktop, and the fork's Android app.
- A separately signed Android APK with its own package ID, and no fork iOS build.
- A Nix flake with the `t3code-<version>` package and the usual T3 Code commands.
- Upstream sync limited to stable releases and proposed as reviewable pull requests.

## Run the source checkout

Install [vp](../operations/development.md#first-checkout), clone this fork, and start its
development server and web client:

```sh
git clone https://github.com/Nitestack/t3code.git
cd t3code
vp i
vp run dev
```

Open the local address printed at startup. Set up a supported T3 provider on the machine running
the server before starting a thread. Give every independent server a separate `T3CODE_HOME`,
including an original T3 server. For NixOS development, see the
[pinned development shell guide](../operations/devenv.md). Connect other clients using the existing
[remote access guide](./remote-access.md).

## Nix install

The repository flake builds the application from source for `x86_64-linux`. Use
`github:Nitestack/t3code/release` to follow the latest published release, or pin a release tag for a
reproducible version. The `release` branch appears after the first published release; `main`
includes unreleased fork changes. The flake provides the standard `t3` and `t3code-desktop`
commands. Follow the [Nix install instructions](./install.md#t3-code-fork-nix).
Nix installs the application only. It does not configure aix profiles or place API keys or resolved
endpoints in the store. Use this package in place of upstream T3 Code because both use the same
default state directory; it does not configure or test an aix profile.

## Updates

The fork follows stable upstream releases only. A daily workflow ignores drafts and prereleases and
opens a sync pull request when a newer stable T3 release appears. It merges only after all four
fork CI jobs pass for the exact pull request head under protected `main`; conflicts and stale or
incomplete checks leave it unmerged. After merge, all four Fork CI jobs must pass on the exact main
integration commit before the existing release workflow builds the Windows installer, signed APK,
and same-version Nix package. The tag and build source are that fork commit; the upstream tag's
peeled commit is recorded as the stable base. The workflow defaults to an Actions artifact without
a tag or GitHub release. Public publication requires explicit authorization and keeps the upstream
version, tag, and release title. See the [fork release runbook](../operations/fork-release.md) for
details. Each successful publication advances the `release` branch only when the new commit is a
fast-forward.

Fork `main` takes only published upstream stable tags; never merge upstream `main`. A tag is synced
only when it contains every upstream commit already present in fork `main`, so the first release is
possible at the first stable tag that contains all commits already merged there.

To update a clean source checkout to the fork's current `main`:

```sh
git pull --ff-only origin main
vp i
```

Then restart with the same `T3CODE_HOME`. Before upgrading, keep a copy of that data directory;
checking out older source does not roll back database migrations. To return to a known-good source
revision, stop the server and run `git switch --detach <known-good-commit>`, then `vp i` and restart.
Do not use the upstream desktop updater or Nix package to update this fork.

For connection and pairing help, see [remote access](./remote-access.md) and
[T3 Connect troubleshooting](./t3-connect-troubleshooting.md). For existing provider and thread
behavior, use the [T3 user guides](../README.md#using-t3-code).
