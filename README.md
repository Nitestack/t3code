# Nitestack/t3code

This repository is a soft fork of [T3 Code](https://github.com/pingdotgg/t3code), created by pingdotgg and released under the [MIT License](./LICENSE). It follows upstream T3 while exploring a fuller T3 × [aix](https://github.com/Nitestack/aix) setup: using aix API-key profiles with T3's existing agent workflows, and organizing connected environments as work or personal.

The fork-specific workflows are still in development. The T3 server, web and desktop clients, provider integrations, remote access, and thread handoffs come from upstream. The current fork does not yet provide a user-facing aix setup, model catalog, profile picker, or Work/Personal switch. See the [fork guide](./docs/user/nitestack-fork.md) for the current limits and how to run this source checkout.

## Run from source

Install [vp](./docs/operations/development.md#first-checkout), then run:

```sh
git clone https://github.com/Nitestack/t3code.git
cd t3code
vp i
T3CODE_HOME="$HOME/.t3-nitestack" vp run dev
```

This starts the local development server and web client. Use the address printed at startup. The explicit `T3CODE_HOME` keeps this server's data separate from any original T3 installation. Set up a provider on the server machine before starting a thread; see [provider setup](./docs/user/install.md#providers).

## Fork builds and original T3 clients

There are no published Nitestack desktop installers, Android APKs, or Nix packages at this time. To check for fork releases and assets, use `gh release list --repo Nitestack/t3code` or visit [Nitestack/t3code releases](https://github.com/Nitestack/t3code/releases). Upstream T3 download and package-manager links install the original product, not this fork.

The official [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) and [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code) apps are upstream clients. There is no fork Android build yet; the iOS app is unchanged and has no fork-specific Work/Personal control. Live compatibility with a fork server has not been established.

## Learn more

- [Nitestack fork guide](./docs/user/nitestack-fork.md)
- [Remote access](./docs/user/remote-access.md)
- [Portable handoffs](./docs/user/portable-handoffs.md)
- [Upstream T3 documentation](./docs/README.md)
- [Upstream T3 repository](https://github.com/pingdotgg/t3code)
