# Fork release runbook

This runbook covers stable upstream syncs and version-matched Windows, Android, and Nix builds for
`Nitestack/t3code`. The fork has no store builds or iOS build. Users can install it from a signed
Android APK, a Windows installer, source, or the pinned Nix flake, as the
[fork guide](../user/nitestack-fork.md) explains.

## Release checklist

1. Start from a reviewed commit on fork `main`, and verify the remotes as in the
   [fork bootstrap](../fork/README.md#bootstrap-from-an-upstream-clone).
2. Confirm `CI` passed on that exact commit. The release workflow verifies the four fork jobs on
   its exact source commit and rejects a source commit outside `main`.
3. Confirm `apps/server`, `apps/desktop`, `apps/web`, and `packages/contracts` use the same stable
   `MAJOR.MINOR.PATCH` version. The Nix flake reads its package version from the server manifest.
4. Run the redaction tests and the diff sweep from [Security checks](#security-checks).
5. If user-visible behavior changed, update "What this fork changes" in the
   [fork guide](../user/nitestack-fork.md#what-this-fork-changes).
6. In GitHub Actions, run `Release` from `main`, choose channel `stable`, and leave `publish`
   unchecked. Enter the matching application version if you want it shown in the Actions run title. The
   workflow builds the signed Android APK, Windows x64 installer, and Nix package from the exact
   source commit, verifies their version and source metadata, and uploads one build-only artifact.
   This run creates no tag or release, including a draft release.
7. Download `t3-code-nitestack-installers-<version>-<12-char-source-sha>` from that Actions run.
   It contains `t3-code-nitestack-<version>-windows-x64.exe`,
   `t3-code-nitestack-<version>.apk`, their `.sha256` files, platform metadata, `nix-build.json`,
   and `BUILD-INFO.md`. The Windows runner records its Authenticode status; without fork Windows
   signing credentials it is expected to be unsigned. The Android APK is signed with the fork's
   upload certificate. Check both checksums and metadata before local installation.
8. After local acceptance, record the build-only run ID, exact commit, and source branch from
   `BUILD-INFO.md`. Request explicit authorization before publishing. Dispatch `Release` on
   `main` with channel `stable`, the same version, `publish` checked, the recorded
   `source_commit` and `source_branch`, and `artifact_run_id` set to the tested build-only run.
   The publisher verifies that run's successful Nix and installer verification jobs, downloads the
   exact artifact, and rechecks every file and source field before creating the upstream-matched
   `vX.Y.Z` tag and `T3 Code vX.Y.Z` release. It does not rebuild the tested installers. A manual
   publish without a tested artifact run is rejected unless ongoing automatic publication is
   explicitly enabled. Do not move or force-push tags.
9. Confirm release notes identify the actual fork commit, source branch, upstream base, and tested
   artifact run, and attach both installers, checksums, platform metadata, Nix build verification,
   and the pinned Nix install command. The Nix build is a required publication gate.

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

`Upstream stable sync` (`.github/workflows/upstream-stable-sync.yml`) scans published releases
daily. An empty stable list or no newer stable version succeeds without writing anything. A manual
run is a dry run unless `dry_run` is cleared, and `target_tag` can select a published stable tag.
Drafts, prereleases, and tags with test labels are ignored.

When a newer stable release exists, the workflow creates an upstream merge branch and pull request.
The push to that exact branch runs the four fork jobs: `Fork Server`, `Fork Web`, `Fork Desktop
Build`, and `Fork Mobile Type and Unit`. The completion handler accepts only the latest successful
push run attempt for the current PR head, verifies each named job individually, checks that the PR
is up to date with `main`, and uses GitHub's ordinary protected merge endpoint. Failed, skipped,
cancelled, missing, stale, or other-head checks never permit the merge. Conflicts stop before merge
for a maintainer to repair. The automated job does not request an administrative bypass.

After a verified merge, the handler queues the existing `Release` workflow for that exact fork
commit and upstream version. Its default is build-only: Windows, signed Android, and Nix must all
build before the combined Actions artifact is available. Automatic publication remains off unless
the `FORK_AUTO_PUBLISH_STABLE_RELEASES` repository variable is explicitly set to `true`; setting it
authorizes future automatic tag and release publication for every eligible sync. Otherwise each
public release needs a separate authorized stable dispatch with `publish` checked and the exact
locally accepted build-only run ID.

## Automation prerequisites

The automation fails closed until these GitHub settings are configured by a repository maintainer;
this implementation does not change repository settings:

- Configure classic branch protection for `main` with strict/up-to-date required status checks for
  the four fork CI jobs above, sourced from the GitHub Actions app (app id `15368`). Enforce the
  rule for administrators, require no additional PR approval, allow merge commits, and do not add
  any ruleset bypass actor. A ruleset alone does not satisfy the workflow's required-check
  preflight.
- Add Actions secrets `FORK_SYNC_APP_ID` and `FORK_SYNC_APP_PRIVATE_KEY` for a GitHub App installed
  only on `Nitestack/t3code`, with `contents:write` and `pull_requests:write`. This App pushes the
  sync branch and opens the PR so its push CI run starts normally.
- Keep organization policy from blocking job-level `GITHUB_TOKEN` write permissions. The merge job
  requests only `actions:write`, `contents:write`, `pull-requests:write`, and
  `administration:read`; the release publisher requests `contents:write`. The repository's
  read-only default can remain in place because each job declares its own scoped permissions. The
  workflow does not approve pull requests or use GitHub's auto-merge setting.
- Keep `FORK_AUTO_PUBLISH_STABLE_RELEASES` unset until ongoing automatic publication is explicitly
  authorized. The default workflow and build-only path do not create tags or draft releases.

With no newer stable release, the daily no-op does not require the App credentials or merge
protection setup. A manual dry run is useful before enabling write automation.

If the merge conflicts, the workflow stops before opening an invalid PR and lists the conflicting
paths. Resolve them by hand on a branch from `main`, merge the published upstream tag, run checks,
and open a pull request. Use the same manual path while Actions is unavailable.

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

- The standalone Android workflow uploads only the APK, its checksum, and `metadata.json`. The
  combined release artifact also contains the Windows installer and Nix verification record.

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

The Android APK and Windows installer still need manual install and acceptance checks on the user's
devices. A successful hosted build does not count as an install smoke test. Record those checks
after downloading a build-only Actions artifact.

## Approved exceptions

The user accepted these gaps as exceptions to fork acceptance on 2026-11-15. Anything not listed
here still needs evidence before release:

- **Live aix profile switching and portable handoff.** Covered by fixture tests only; no live
  profile-to-profile turn has run.
- **aix profile changes without a rebuild.** This needs a credential integration path that does
  not exist yet.

## First release

The clone contains an imported upstream `v0.1.9` tag. It is not a Nitestack release, and it must not
be moved, deleted, or force-pushed. Start `Release` manually from a reviewed, green `main` commit
with `publish` unchecked to build the Windows installer, signed APK, and same-version Nix package.
Download the resulting Actions artifact and test it locally. No tag or release is created by this
step. After explicit authorization, dispatch the stable workflow for the reviewed exact source with
`publish` checked and `artifact_run_id` set to the accepted build-only run. It creates
`vX.Y.Z` titled `T3 Code vX.Y.Z` from those same tested installer bytes. The notes identify the
fork commit, source branch, upstream base, and build-only run, and the Nix command resolves the fork
repository.

The `Nitestack Android APK` workflow remains available for a standalone signed build artifact. Its
legacy `t3-android-vMAJOR.MINOR.PATCH` tag route remains compatible; use the `Release` workflow for
the Windows, Android, and Nix build-only artifact or for an authorized canonical fork release.
