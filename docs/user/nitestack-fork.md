# Nitestack/t3code fork

Nitestack/t3code is a soft fork of [T3 Code](https://github.com/pingdotgg/t3code), created by
pingdotgg and distributed under the MIT License. It preserves T3's supported providers, threads,
and remote access while developing runtime support for [aix](https://github.com/Nitestack/aix)
API-key profiles and client-side Work/Personal views of connected environments.

## aix profiles and native compatibility

Use the [aix setup and profile guide](https://github.com/Nitestack/aix/blob/main/README.md) to
configure aix itself. This fork does not yet provide a supported T3 control to activate aix
profiles or select their models. Installing aix alone does not make its profiles available in T3.

Partial aix development work exists, but there is no end-user setup flow. The only credential path
implemented so far is scoped to direct Anthropic Claude profiles; its fixture coverage does not
establish a working native T3 Claude CLI flow. LiteLLM profiles and OpenCode are not available as
aix product features. A Codex probe failed before a tool result or final response, but that single
result does not establish general incompatibility. The
[native compatibility report](../fork/t01-native-agent-spike.md) records the tested combinations
and evidence limits.

The direct Anthropic Claude probe completed a tool call and final response for the requested model.
It does not validate LiteLLM aliases or arbitrary models. The T3 credential-boundary fixtures are
offline tests; they are not proof of a live aix profile flow. API keys remain in aix's credential
handling and should not be added to T3 settings or Nix configuration.

There is no user-facing aix picker, manual catalog refresh, or stale-catalog behavior. T3's existing
[portable handoffs](./portable-handoffs.md) continue to work for supported provider switches, but
aix profile switching and its context handoff have not been verified.

## Work/Personal and mobile

The web, desktop, and Android-fork source includes a Work/Personal view that filters connected
environments using locally stored classifications. On Android, this is enabled only in the fork
variant; it does not change the official Android or iOS apps. The Android implementation is a
source preview and has not had a two-environment device smoke. The full real-client pass, including
search routes, active-task behavior, and notifications, remains open. The view is only a client-side
filter. It does not provide access control or isolate server data. For actual server separation, run
separate T3 data directories using `T3CODE_HOME` as described in the
[isolated Nix launch guide](./install.md#t3-code-fork-nix).

An Android variant and build workflow are in the source, but there is no verified signed APK or
published fork download. See the
[Android build guide](../operations/android-fork-apk.md) for build status; upstream Android
downloads are not fork builds. The official Android and iOS apps are unchanged upstream clients,
and their compatibility with a fork server has not been established. The official iOS app has no
fork-specific Work/Personal switch.

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

The source includes a guarded workflow for checking stable upstream releases. It runs daily, and
manual dispatch defaults to a dry run that creates no PR. A
[manual dry run](https://github.com/Nitestack/t3code/actions/runs/43554789828) completed an
up-to-date check successfully. A non-dry-run is intended to propose a PR when a new stable release
is found; automatic PR creation remains unverified and is currently blocked by the repository's
Actions policy. The workflow does not auto-merge or publish a fork release. See the
[workflow source](../../.github/workflows/upstream-stable-sync.yml).

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
