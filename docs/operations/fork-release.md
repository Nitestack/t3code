# Fork release runbook

This runbook covers releases of `Nitestack/t3code`: syncing stable upstream releases, cutting the
signed Android APK, and rolling either back. The fork has no desktop installers, store builds, or
iOS builds. Users run it from source or the pinned Nix flake, as the
[fork guide](../user/nitestack-fork.md) explains.

## Release checklist

1. Start from a clean, current `main`, and verify the remotes as in the
   [fork bootstrap](../fork/README.md#bootstrap-from-an-upstream-clone).
2. Confirm that fork CI passed on the commit you release. While Actions is blocked (see
   [Known issues](#known-issues)), run the local checks below and record the commit and results in
   the release notes instead.
3. Run the redaction tests and the diff sweep from [Security checks](#security-checks).
4. If user-visible behavior changed, update "What this fork changes" in the
   [fork guide](../user/nitestack-fork.md#what-this-fork-changes).
5. For an Android release, push a `t3-android-vMAJOR.MINOR.PATCH` tag from that commit, as described
   in the [Android APK guide](./android-fork-apk.md). Never push upstream-style `vX.Y.Z` tags.

Local checks for a release commit, each run from the package directory:

```sh
# apps/server
vp test run src/aix src/provider/AixDiscovery.test.ts src/provider/CodexAixLaunch.test.ts \
  src/provider/OpenCodeAixLaunch.test.ts src/provider/Drivers/OpenCodeAixDriver.test.ts \
  src/provider/Drivers/ClaudeHome.test.ts src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts
# packages/contracts, packages/client-runtime, apps/web, apps/mobile
vp test run
# repository root
node --test scripts/upstream-stable-sync.test.mjs
```

Each package also has `vp run typecheck`. Web browser tests on NixOS need the
[devenv shell](./devenv.md).

## Stable upstream sync

`Upstream stable sync` (`.github/workflows/upstream-stable-sync.yml`) runs daily and on manual
dispatch. A manual run is a dry run unless you clear `dry_run`, and `target_tag` selects a specific
published release. It ignores drafts, prereleases, and tags with test labels. For a new stable tag it
merges the tag into a branch from the fork's `main`, pushes `automation/upstream-stable-<tag>`, opens
a pull request, and dispatches fork CI on that branch. It never approves or merges.

Review a sync pull request like any other:

- CI on the branch passed.
- Changes to `packages/contracts` keep aix models on the standard provider instance and model
  fields. Rerun the contract and mobile model-option tests listed in
  [Compatibility evidence](#compatibility-evidence).
- The aix and Work/Personal suites still pass, and fork files such as the workflows, this runbook,
  and the fork docs survived the merge.

If the merge conflicts, the workflow stops without pushing and lists the conflicting paths. Resolve
them by hand: on a new branch from `main`, run `git fetch upstream --tags` and
`git merge --no-ff <tag>`, resolve the conflicts, run the checks, and open a pull request. Use the
same manual path while Actions is unavailable.

To roll back a merged sync, revert its merge commit on a branch with `git revert -m 1 <merge>` and
merge that through a pull request. Users who already ran the newer server keep its database
migrations, so tell them to restore the data directory backup the
[update guide](../user/nitestack-fork.md#updates) asks for, rather than only checking out older
source.

## Security checks

Credentials stay out of settings, logs, client responses, and artifacts. Before a release:

- The sentinel-key tests pass. They live in `apps/server/src/aix/ProviderInstanceSync.test.ts` (no
  key in persisted settings or logs), `packages/contracts/src/server.test.ts` (no provider config
  or key in the client DTO), `apps/server/src/provider/AixDiscovery.test.ts`,
  `apps/server/src/aix/ModelCatalog.test.ts`, the `*AixLaunch.test.ts` files, and the text
  generation tests (failed processes and requests redact the key).
- Sweep the fork diff for private paths and credential-like strings:

  ```sh
  BASE="$(git merge-base origin/main upstream/main)"
  git diff "$BASE"..origin/main -- . ':!.repos' ':!pnpm-lock.yaml' ':!*.lock' | grep -E '^\+' |
    grep -nEi '/home/|/Users/|/nix/store/|\.jks|BEGIN [A-Z ]*PRIVATE|ghp_|github_pat_|sk-[A-Za-z0-9_-]{12,}'
  ```

  Expected hits are test sentinels, the `/home/user` fixture paths, and the keystore steps in the
  Android workflow and guide. Anything else needs a look before releasing.

- The Android workflow uploads only the APK, its checksum, and `metadata.json`.

## Compatibility evidence

The fork must stay usable with original T3 servers and clients. Rerun the evidence that matches a
change:

| Claim                                                                  | Evidence                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| aix models use standard provider DTOs; clients ignore the extra fields | `packages/contracts/src/server.test.ts`, the `aixDesiredInstances` decode test in `ProviderInstanceSync.test.ts`, `apps/mobile/src/lib/modelOptions.test.ts`, and the [mobile protocol notes](../fork/mobile-protocol-compatibility.md) |
| Fork and upstream web clients and servers interoperate                 | A live two-way matrix against upstream `449deb635e`: pairing, thread continuation, model picker, new thread, provider refresh                                                                                                           |
| Native agent and model pairs                                           | [Native agent compatibility report](../fork/t01-native-agent-spike.md) and `apps/server/src/aix/ModelRouting.test.ts`                                                                                                                   |
| Profile and model switching, with no silent fallback                   | `apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts` (aix cases)                                                                                                                                               |
| Work/Personal never touches server state                               | `packages/client-runtime/src/environment/scope.test.ts`, `apps/web/src/environmentScope.test.ts`, the Android scope tests, and a live two-environment web scenario                                                                      |
| Original and fork installs coexist                                     | The Linux Nix coexistence smoke, with separate `T3CODE_HOME` and `XDG_CONFIG_HOME`                                                                                                                                                      |

The official Android and iOS apps, the fork APK on a device, and macOS and Windows desktop hosts
have not been run. Record such a run when one becomes possible.

## Known issues

- **GitHub Actions does not start workflows on the fork.** `workflow_dispatch` returns HTTP 422
  "Actions has been disabled for this repository", although the repository's Actions permissions
  API reports Actions as enabled and the workflows are active. Push-triggered runs stay queued until
  cancelled. Until GitHub support or a settings change resolves this, fork CI, the scheduled
  upstream sync, and the APK workflow do not run. Use the local checks and the manual sync path.
- **Fork servers reject `options: null` in a model selection.** Upstream fixed this in `f4e65cd843`.
  It arrives with the next upstream sync.
- **Android APK certificate check.** The workflow's fixed parsing of the `apksigner` certificate
  line has not run live yet. The previous live run produced an APK whose signer certificate matched
  the upload keystore.
