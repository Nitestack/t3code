# Nitestack/t3code fork

Nitestack/t3code is a soft fork of [T3 Code](https://github.com/pingdotgg/t3code), created by pingdotgg and distributed under the MIT License. The fork's direction is to pair T3's existing agent and remote-work flows with [aix](https://github.com/Nitestack/aix) API-key profiles and a client-side work/personal view of environments.

## What works today

The fork inherits T3's existing web and desktop experience, provider integrations, remote access, and portable handoffs. Fork-specific aix workflows are not ready for users yet:

- An aix discovery adapter is present in the server, but there is no supported setting or command to activate aix profiles or use their credentials with an agent.
- LiteLLM model discovery, catalog refresh and stale-catalog behavior are not available. There is no aix profile/model picker or profile switch for a thread. T3's existing handoffs continue to work for the providers T3 already supports; they do not switch to aix profiles.
- Client-side environment scope preferences are stored, but there is no Work/Personal switch or complete filtering UI yet. When available, this will only organize what a client shows. It will not restrict server access or protect data.

Although aix 0.1.0 is available, live compatibility between aix profiles and T3's native agents has not been established. Installing aix alone does not enable it in this fork. No activation flags, API-key settings, or manual refresh controls are currently supported.

## Run the source checkout

Install [vp](../operations/development.md#first-checkout), clone this fork, and start its development server and web client:

```sh
git clone https://github.com/Nitestack/t3code.git
cd t3code
vp i
T3CODE_HOME="$HOME/.t3-nitestack" vp run dev
```

Open the local address printed at startup. Set up an existing T3 provider on the machine running the server before starting a thread. Keep a different `T3CODE_HOME` for every independent server, including an original T3 server; each home stores that server's data and connection state. Connect other clients using the existing [remote access guide](./remote-access.md). Live fork-client and official-mobile compatibility with a fork server remains unverified.

## Clients and downloads

There are no published Nitestack desktop installers, fork Android APKs, or fork Nix packages today. Check for releases with the read-only command:

```sh
gh release list --repo Nitestack/t3code
```

The upstream [T3 downloads](https://t3.codes/download), package-manager packages, and [nixpkgs package](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code) install original T3, not this fork. The official [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code) and [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) apps are unchanged upstream clients. There is no fork-specific Android app yet. The iOS app has no Work/Personal switch, and its live compatibility with a fork server has not been verified.

## Updates, rollback, and help

The fork does not yet automate stable upstream synchronization or publish a fork update channel. To update a clean source checkout to the fork's current `main`, run:

```sh
git pull --ff-only origin main
vp i
```

Then restart with the same `T3CODE_HOME`. Before upgrading, keep a copy of that data directory: checking out older source does not roll back database migrations. To return to a known-good source revision, stop the server and run `git switch --detach <known-good-commit>`, then `vp i` and restart. Do not use the upstream desktop updater or Nix package to update this fork.

If you expected aix controls, a dynamic model list, a refresh action, or a Work/Personal switch, that workflow is not available in this version. For connection and pairing help, see [remote access](./remote-access.md) and [T3 Connect troubleshooting](./t3-connect-troubleshooting.md). For existing provider and thread behavior, use the [T3 user guides](../README.md#using-t3-code).
