# Nitestack/t3code

This is a soft fork of [T3 Code](https://github.com/pingdotgg/t3code), created by pingdotgg and
released under the [MIT License](./LICENSE). It keeps T3's provider, thread, and remote-work
flows while developing runtime support for [aix](https://github.com/Nitestack/aix) profiles and
client-side Work/Personal environment views.

The Work/Personal switch is available in the web and desktop source as a development preview; its
full two-environment and active-task acceptance pass is still open. It only filters the client view
and is not an access-control boundary. aix discovery and model-catalog code exist, but aix profiles
cannot yet be activated in T3 or selected in a model picker. The [native compatibility spike](./docs/fork/t01-native-agent-spike.md)
has partial runtime results; it does not approve general aix routing. See the [fork guide](./docs/user/nitestack-fork.md)
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

## Nix and fork builds

The repository includes a pinned Nix flake for `x86_64-linux`; it builds the fork from a reviewed
source commit and provides distinct `t3code-fork` and `t3code-fork-desktop` commands. It is a source
package, not a published fork binary. Follow the [Nix install and isolated launch guide](./docs/user/install.md#t3-code-fork-nix).
An x86_64 Linux coexistence smoke succeeded with the nixpkgs T3 package and the fork source build,
using separate data homes and desktop locks. It did not exercise an aix profile.

There is no verified published fork Android APK yet. The repository has an Android build workflow,
but signing-secret setup, a successful signed release build, and device installation are still open.
The official iOS app is unchanged and has no fork Work/Personal switch. Official mobile-client
compatibility with the fork server has not been established. See the [Android build guide](./docs/operations/android-fork-apk.md).

## Upstream updates

A guarded stable-release sync workflow is present in the source. It checks daily at 23:37 UTC and
supports manual dispatch with a dry run enabled by default. It proposes reviewable pull requests;
it does not auto-merge or publish a fork release. Operational acceptance is still open: the fork's
GitHub token policy prevents PR creation, and the first push-triggered fixture run failed during checkout before the
sync script started. A narrow CI repair is in progress.
See the [workflow](./.github/workflows/upstream-stable-sync.yml) and
[fork update guide](./docs/user/nitestack-fork.md#updates).

## Learn more

- [Nitestack fork guide](./docs/user/nitestack-fork.md)
- [aix profiles and native compatibility](./docs/user/nitestack-fork.md#aix-profiles-and-native-compatibility)
- [Catalog and Work/Personal status](./docs/user/nitestack-fork.md#catalog-and-workpersonal-status)
- [Remote access](./docs/user/remote-access.md)
- [Portable handoffs](./docs/user/portable-handoffs.md)
- [Upstream T3 documentation](./docs/README.md)
- [Upstream T3 repository](https://github.com/pingdotgg/t3code)
