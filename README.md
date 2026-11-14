# Nitestack/t3code

This is a soft fork of [T3 Code](https://github.com/pingdotgg/t3code), created by pingdotgg and
released under the [MIT License](./LICENSE). It preserves T3's provider, thread, and remote-work
flows while developing runtime support for [aix](https://github.com/Nitestack/aix) profiles and
client-side Work/Personal environment views.

The web and desktop source includes a Work/Personal filtering preview. Its full two-environment
acceptance pass, including search routes, active tasks, and notifications, is still open. The view
filters what the client shows; it is not an access-control boundary. aix discovery and catalog code
are present, but there is no supported T3 setup or picker for aix profiles. See the [fork guide](./docs/user/nitestack-fork.md)
for current capabilities and limits.

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

The repository has an Android variant and build workflow, but there is no verified signed APK or
published fork download. The official iOS
app is unchanged and has no fork Work/Personal switch; official mobile-client compatibility with
the fork server has not been established. See the [Android build guide](./docs/operations/android-fork-apk.md).

## Upstream updates

A guarded stable-release sync workflow checks upstream daily and supports manual dispatch. Manual
dry runs create no PR. A [manual dry run](https://github.com/Nitestack/t3code/actions/runs/43554789828)
completed an up-to-date check successfully. A non-dry-run is intended to propose a PR when it finds
a new stable release; that PR path remains unverified and is currently blocked by the repository's
Actions policy. The workflow
does not auto-merge or publish a fork release. See the
[fork update guide](./docs/user/nitestack-fork.md#updates).

## Learn more

- [Nitestack fork guide](./docs/user/nitestack-fork.md)
- [aix profiles and native compatibility](./docs/user/nitestack-fork.md#aix-profiles-and-native-compatibility)
- [Work/Personal and mobile status](./docs/user/nitestack-fork.md#workpersonal-and-mobile)
- [Remote access](./docs/user/remote-access.md)
- [Portable handoffs](./docs/user/portable-handoffs.md)
- [Upstream T3 documentation](./docs/README.md)
- [Upstream T3 repository](https://github.com/pingdotgg/t3code)
