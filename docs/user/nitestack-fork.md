# Nitestack/t3code fork

Nitestack/t3code is a soft fork of [T3 Code](https://github.com/pingdotgg/t3code), created by
pingdotgg and distributed under the MIT License. The fork develops runtime support for [aix](https://github.com/Nitestack/aix)
API-key profiles and client-side Work/Personal views of connected environments.

## What works today

The source checkout includes T3's web and desktop clients, provider integrations, remote access,
portable handoffs, and a Work/Personal view in web and desktop. The view is a development preview:
the real-client pass across two environments, including active-task and notification behavior, is
still open. It only filters what the client shows; it is not an access-control or data-isolation
boundary.

The server contains aix discovery and LiteLLM catalog modules, but no supported setting or command
activates aix profiles, and there is no aix profile/model picker or thread profile switch. T3's
existing handoffs continue to work for its supported providers; they do not select aix profiles.
Installing aix alone does not enable aix in T3.

## aix profiles and native compatibility

Use the [aix setup and profile guide](https://github.com/Nitestack/aix/blob/main/README.md) to
configure aix itself. This fork does not yet offer an aix activation control. Keep API keys in aix's
credential handling rather than adding them to T3 settings or Nix configuration.

The [native compatibility findings](../fork/t01-native-agent-spike.md) record partial results for
Codex, Claude Code, and OpenCode. One direct Anthropic Claude route completed a tool-using turn; a
Codex run failed before a tool or final response; two OpenCode runs did not echo the requested model
ID. These results do not approve general aix routing. Profile isolation, credential rotation, and
profile-switch handoff remain unverified. See [portable handoffs](./portable-handoffs.md) for T3's
existing context-transfer behavior.

## Catalog and Work/Personal status

Catalog discovery and normalization code is present, but it does not populate a user-facing aix
picker. There is no supported catalog refresh command or stale-cache behavior for aix profiles.
Installing aix or changing its profile will not activate T3 catalog refresh.

The web and desktop Work/Personal view uses locally stored environment classifications. The
integrated real-client pass is still open, so do not rely on it to verify active-task or
cross-scope notification behavior. The view does not change server permissions, running tasks, or
data access. For actual server separation, use distinct T3 data directories as described below.

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
including an original T3 server. For NixOS development, see the [pinned development shell guide](../operations/devenv.md).
Connect other clients using the existing [remote access guide](./remote-access.md). Live
fork-client and official-mobile compatibility with a fork server remains unverified.

## Nix and clients

The repository has a pinned source flake for `x86_64-linux`, with separate `t3code-fork` and
`t3code-fork-desktop` commands. It builds the application from a reviewed source commit; there is
no published fork binary package. Follow the [Nix install and isolated launch instructions](./install.md#t3-code-fork-nix).
Nix installs the application only. It does not configure aix profiles or place API keys or
resolved endpoints in the store. A Linux smoke ran nixpkgs T3 `0.1.8` alongside fork build
`0.1.9-fork.f54c668`; both returned HTTP 200 with separate T3 homes, Electron locks, and
environment IDs, and cleanup was verified. The smoke did not change or test an aix profile.

There are no published Nitestack desktop installers or verified signed Android APKs. The source
includes an Android variant and [build workflow instructions](../operations/android-fork-apk.md),
but signing-secret setup, a successful signed release build, and an install smoke test remain open.
The official Android and iOS apps are unchanged upstream clients. The iOS app has no fork-specific
Work/Personal switch, and live compatibility of official mobile clients with a fork server has not
been established.

## Updates

A guarded stable-release sync workflow is present in the source, scheduled daily at 23:37 UTC.
Manual dispatch defaults to a dry run, which creates no PR. A non-dry-run is intended to propose a
reviewable PR when it finds a new stable upstream release; no successful sync dispatch or sync PR
has been demonstrated. It does not auto-merge or publish a fork release. The first push-triggered
fixture run failed during checkout before the sync script started, and the fork's GitHub token
policy currently prevents PR creation. A narrow CI repair is in progress.
See the [workflow source](../../.github/workflows/upstream-stable-sync.yml).

Until a reviewed update is available on the fork's remote, update a clean source checkout to the
fork's current `main` with:

```sh
git pull --ff-only origin main
vp i
```

Then restart with the same `T3CODE_HOME`. Before upgrading, keep a copy of that data directory:
checking out older source does not roll back database migrations. To return to a known-good source
revision, stop the server and run `git switch --detach <known-good-commit>`, then `vp i` and restart.
Do not use the upstream desktop updater or Nix package to update this fork.

For connection and pairing help, see [remote access](./remote-access.md) and
[T3 Connect troubleshooting](./t3-connect-troubleshooting.md). For existing provider and thread
behavior, use the [T3 user guides](../README.md#using-t3-code).
