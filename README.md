# Nitestack/t3code

This is a soft fork of [T3 Code](https://github.com/pingdotgg/t3code), created by pingdotgg and
released under the [MIT License](./LICENSE). It preserves T3's provider, thread, and remote-work
flows and adds runtime support for [aix](https://github.com/Nitestack/aix) API-key profiles and a
client-side Work/Personal view of connected environments.

Start the server with `T3CODE_AIX=1` to offer aix profiles as provider instances in the model
picker. Without it, the fork behaves like upstream T3. The Work/Personal view filters what a client
shows; it is not an access-control boundary. See the [fork guide](./docs/user/nitestack-fork.md) for
current capabilities and limits.

## Run from source

Install [vp](./docs/operations/development.md#first-checkout), then run:

```sh
git clone https://github.com/Nitestack/t3code.git
cd t3code
vp i
T3CODE_HOME="$HOME/.t3-nitestack" vp run dev
```

Open the address printed at startup. The explicit `T3CODE_HOME` keeps this server's data separate
from an original T3 installation. Set up a supported T3 provider on the server machine before
starting a thread; see [provider setup](./docs/user/install.md#providers).

## Nix and mobile

The repository includes a pinned source flake for `x86_64-linux`, with separate `t3code-fork` and
`t3code-fork-desktop` commands. It builds the fork from a reviewed source commit; it is not a
published fork binary. See the [Nix install and isolated launch guide](./docs/user/install.md#t3-code-fork-nix).

The repository has a signed Android APK workflow with its own package name; no fork APK has been
published or installed on a device yet. The official iOS and Android apps are unchanged and have no
fork Work/Personal switch, and they have not yet been run against a fork server. See the
[Android build guide](./docs/operations/android-fork-apk.md).

Fork release assets, when available, are listed under [Nitestack/t3code releases](https://github.com/Nitestack/t3code/releases).
Upstream downloads install original T3.

## Upstream updates

A guarded workflow checks upstream daily for stable releases and proposes them as reviewable pull
requests; it never auto-merges. See the [fork update guide](./docs/user/nitestack-fork.md#updates)
and the [fork release runbook](./docs/operations/fork-release.md).

## Learn more

- [Nitestack fork guide](./docs/user/nitestack-fork.md)
- [aix profiles](./docs/user/nitestack-fork.md#aix-profiles)
- [Work/Personal view](./docs/user/nitestack-fork.md#workpersonal-view)
- [Mobile apps](./docs/user/nitestack-fork.md#mobile-apps)
- [Remote access](./docs/user/remote-access.md)
- [Portable handoffs](./docs/user/portable-handoffs.md)
- [Upstream T3 documentation](./docs/README.md)
- [Upstream T3 repository](https://github.com/pingdotgg/t3code)
