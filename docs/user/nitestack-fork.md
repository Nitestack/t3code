# Nitestack/t3code fork

Nitestack/t3code is a soft fork of [T3 Code](https://github.com/pingdotgg/t3code), created by
pingdotgg and distributed under the MIT License. It keeps T3's providers, threads, and remote access,
and adds runtime support for [aix](https://github.com/Nitestack/aix) API-key profiles and a
client-side Work/Personal view of connected environments.

## aix profiles

Configure aix itself with the [aix setup and profile guide](https://github.com/Nitestack/aix/blob/main/README.md).
To use its profiles in T3, start the fork's server with `aix` on its `PATH` and `T3CODE_AIX=1` in
its environment. Without that variable the server behaves like upstream T3, and instances it created
for aix earlier are disabled. Your own Codex, Claude, and other provider sign-ins are not changed.

T3 reads the profile list from aix and asks aix for each profile's endpoint and key inside the server
process. Keys are never written to T3 settings or sent to clients. ChatGPT sign-in profiles are not
supported; keep using the regular Codex provider for a ChatGPT subscription.

Each usable profile appears in the model picker as one or more provider instances named after the
profile, such as `Work · Codex` or `Work · OpenCode`. A model's details show its family, context
window, maximum output, input and output prices per million tokens, and reasoning levels. Values the
gateway does not report show as Unknown. The model ID sent to the gateway is the original ID.

Only models that can run are offered:

- A direct Anthropic API profile offers Claude models only.
- Native Codex and Claude Code are used only for model and endpoint combinations that were verified
  with a real tool-using turn. Today that is `gpt-6.1-sol` on a LiteLLM Responses route for Codex and
  `claude-opus-5-5` on the Anthropic API for Claude Code.
- Other chat models from a LiteLLM gateway run in OpenCode, which T3 configures for that profile. You
  do not need to install a provider login or write an OpenCode config for it.
- Embedding, image, and generic wildcard routes are not listed.

If a selected model or profile stops working, the turn fails with an error. T3 never switches to a
different model or agent for you.

When a profile's LiteLLM key has a budget, the usage limits panel shows it as a Gateway budget bar
for each of that profile's instances, with its reset time when the gateway reports one. A key
without a budget, or a direct Anthropic profile, shows no bar.

### Refresh and key rotation

Profiles and model catalogs are loaded when the server starts and reloaded at most once a day.
Use the refresh button next to an aix profile in the model picker to reload immediately, for
example after adding a profile or model in aix. If a reload fails, the picker keeps the last catalog and marks it stale. A
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

Web, desktop, and the fork's Android app have a Work/Personal switch. Use **Classify environments**
next to it to mark each connected environment as Work. Environments you have not classified count
as Personal. The switch filters the sidebar, project and thread
pickers, search, and the command palette, and new threads are created in the active view. Switching
never stops running turns or queued work, and notifications are not filtered by view. The switch
is saved per client. Shared preferences such as theme and shortcuts stay shared, and
environment and project settings keep their usual scope.

The view is only a client-side filter. It does not provide access control or isolate server data.
For real separation, run separate T3 servers with their own data directories using `T3CODE_HOME` as
described in the [isolated Nix launch guide](./install.md#t3-code-fork-nix). One client can connect
to both an original T3 server and a fork server.

## Mobile apps

The fork's Android app uses its own package name and link scheme, so it is meant to install next to
the official app. Its signed APK comes from the fork's build workflow; there is no store listing, and
installing it on a device has not been verified yet. See the
[Android build guide](../operations/android-fork-apk.md).

The official Android and iOS apps are unchanged upstream clients. aix profiles reach them as regular
provider instances with standard model choices, and the upstream web client was verified against a
fork server. The official phone apps have not yet been run against a fork server. They do not show the
Work/Personal switch or the extra model details; use their existing environment selection instead.
There is no fork iOS app.

## What this fork changes

Compared with upstream T3 Code at
[`0de6ddb823`](https://github.com/pingdotgg/t3code/commit/0de6ddb8235debee8c7119343e1a4da9cd8b5de8), the upstream commit last merged into the fork:

- aix API-key profiles as provider instances for Codex, Claude Code, and a T3-managed OpenCode,
  enabled with `T3CODE_AIX=1`.
- Model details for aix models: family, context window, prices, reasoning levels, refresh, and a
  stale-catalog warning.
- An aix profile's LiteLLM key budget in the usage limits panel.
- A client-side Work/Personal view on web, desktop, and the fork's Android app.
- A separately signed Android APK with its own package name, and no fork iOS build.
- A pinned Nix flake with `t3code-fork` commands that install next to the original T3 Code.
- Upstream sync limited to stable releases and proposed as reviewable pull requests.

## Run the source checkout

Install [vp](../operations/development.md#first-checkout), clone this fork, and start its
development server and web client:

```sh
git clone https://github.com/Nitestack/t3code.git
cd t3code
vp i
T3CODE_HOME="$HOME/.t3-nitestack" vp run dev
```

Open the local address printed at startup. Set up a supported T3 provider on the machine running
the server before starting a thread. Give every independent server a separate `T3CODE_HOME`,
including an original T3 server. For NixOS development, see the
[pinned development shell guide](../operations/devenv.md). Connect other clients using the existing
[remote access guide](./remote-access.md).

## Nix install

The repository has a pinned source flake for `x86_64-linux`, with separate `t3code-fork` and
`t3code-fork-desktop` commands. It builds the application from a reviewed source commit; there is
no published fork binary package. Follow the [Nix install and isolated launch instructions](./install.md#t3-code-fork-nix).
Nix installs the application only. It does not configure aix profiles or place API keys or resolved
endpoints in the store. The Linux coexistence smoke used separate data homes and desktop locks; it
did not configure or test an aix profile.

## Updates

The fork follows stable upstream releases only. A daily workflow checks for a new stable T3 release
and proposes it as a pull request for review; it never merges on its own and ignores drafts and
prereleases. Fork changes reach `main` only after review, so update from `main`, not from upstream.
See the [fork release runbook](../operations/fork-release.md) for the current status.

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
