# Fork release runbook

This runbook covers stable upstream syncs and version-matched Windows, macOS, Linux AppImage, Android, and Nix builds for
`get-aix/t3code`. The fork has no store builds or iOS build. Users can install it from a signed
Android APK, a Windows installer, the macOS install script, a Linux AppImage, source, or the latest-release or pinned Nix flake ref, as the
[fork guide](../user/nitestack-fork.md) explains.

The Nix package is `t3code-<version>` and uses the upstream `t3` and `t3code-desktop` commands,
T3 Code app name, and default state directory. Install it instead of upstream T3 Code; the Android
APK uses the official package ID and replaces the store app.

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
   workflow builds the signed Android APK, Windows x64 installer, macOS arm64 app, Linux x64 AppImage, and Nix package from the exact
   source commit, verifies their version and source metadata, and uploads one build-only artifact.
   This run creates no tag or release, including a draft release. If the selected source has no
   `.github/upstream-stable.json` marker, provide `upstream_base` as the full peeled commit SHA for
   the matching upstream `v<version>` tag. An invalid or mismatched marker always blocks the run.
7. Download `t3-code-installers-<version>-<12-char-source-sha>` from that Actions run.
   It contains `T3-Code-<version>-x64.exe`, `T3-Code-<version>.apk`, `T3-Code-<version>-arm64.{dmg,zip}`, `T3-Code-x86_64.AppImage`, `T3-Code-<version>-amd64.deb`, their `.sha256` files, blockmaps, the `latest*.yml` update feeds, `install-macos.sh`, platform metadata, `nix-build.json`,
   and `BUILD-INFO.md`. All metadata names the fork integration commit as the built source and
   records the upstream stable tag and peeled base commit separately. The Windows runner records its Authenticode status; without fork Windows
   signing credentials it is expected to be unsigned. The macOS app is signed with the fork's self-signed `T3 Code Fork` certificate (secrets `MACOS_SELF_SIGNED_CERTIFICATE` and `MACOS_SELF_SIGNED_CERTIFICATE_PASSWORD`) and is not notarized. Keep that certificate: installed Macs accept in-app updates only from builds signed with the same one, so a new certificate means every Mac must reinstall with the script. The Android APK is signed with the fork's
   upload certificate. Check both checksums and metadata before local installation.
8. After local acceptance, record the build-only run ID, exact commit, and source branch from
   `BUILD-INFO.md`. Request explicit authorization before publishing. Dispatch `Release` on
   `main` with channel `stable`, the same version, `publish` checked, the recorded
   `source_commit` and `source_branch`, and `artifact_run_id` set to the tested build-only run.
   The publisher verifies that run's successful Nix and installer verification jobs, downloads the
   exact artifact, and rechecks every file and source field before creating the upstream-matched
   `vX.Y.Z` tag and `T3 Code vX.Y.Z` release. It does not rebuild the tested installers. A manual
   publish without a tested artifact run is rejected unless ongoing automatic publication is
   explicitly enabled. To publish manually, first run a build-only release, then dispatch again
   with `publish=true` and that run's `artifact_run_id`. `FORK_AUTO_PUBLISH_STABLE_RELEASES=true`
   authorizes automatic publication only. Do not move or force-push tags.
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

## Fork fixes between upstream releases

Release fork fixes the same way, from `main`, without editing any manifest. Preflight derives the
version: a source whose upstream base `vX.Y.Z` is already published for another commit becomes
`X.Y.(Z+1)-aix.N`, with `N` one past the highest existing fork tag of that patch (at most 98).
Rerunning on a commit that already has a fork tag reuses that version. This sorts above the base
release and below upstream's next stable, so installed desktop apps update to the fork fix and
later to the upstream sync. The desktop feed stays on channel `latest`; electron-builder would
otherwise name a `-aix.N` feed after its prerelease tag.

Builds are stamped with the fork version at release time, so upstream sync merges never conflict on
it. The Nix flake versions itself from source and still builds `t3code-<X.Y.Z>`; the pinned flake
ref uses the fork tag. Android version codes are `(major*1e6 + minor*1e3 + patch)*100` plus `N`
for a fork fix or 99 for a plain release, as `fork-release.cjs` and `apps/mobile/app.config.ts`
compute.

## Stable upstream sync

`Upstream stable sync` (`.github/workflows/upstream-stable-sync.yml`) scans published releases
daily. An empty stable list or no newer stable version succeeds without writing anything. A manual
run is a dry run unless `dry_run` is cleared, and `target_tag` can select a published stable tag.
Drafts, prereleases, and tags with test labels are ignored.

When a newer compatible stable release exists, the workflow creates a stable-tag branch and pull request.
The push to that exact branch runs the four fork jobs: `Fork Server`, `Fork Web`, `Fork Desktop
Build`, and `Fork Mobile Type and Unit`. The completion handler accepts only the latest successful
push run attempt for the current PR head, verifies each named job individually, checks that the PR
is up to date with `main`, and uses GitHub's ordinary protected merge endpoint. Failed, skipped,
cancelled, missing, stale, or other-head checks never permit the merge. Conflicts stop before merge
for a maintainer to repair. The automated job does not request an administrative bypass.

If `main` advances while the sync checks are running, the handler leaves the PR open and unmerged.
Update its branch and let the resulting push run all four checks again before the next merge attempt.

Fork `main` accepts only published upstream stable tags; never merge upstream `main`. A tag is
eligible only when it contains every upstream commit already present in fork `main`. The first
release can be cut only at the first stable tag that contains all upstream commits already merged
into fork `main`.

After the sync PR merges, the main push runs all four Fork CI jobs on its integration merge commit.
Only that exact successful main CI run queues the existing `Release` workflow, passing the fork
integration commit as `source_commit`; the upstream tag commit is recorded only as `upstream_base`.
The integration commit tree contains the fork changes and upstream through the stable tag. The
workflow compares commits reachable from that source after the stable base with upstream `main`;
any upstream-main commit beyond the selected stable tag fails the release preflight and reports the
count and first short SHAs. This read-only history check never merges upstream `main`. Its default is
build-only: Windows, signed Android, and Nix must all build before the combined Actions artifact is
available. Automatic publication is off by default.
Setting the `FORK_AUTO_PUBLISH_STABLE_RELEASES` repository variable to `true` is the user's explicit
standing authorization for every eligible sync to publish; unset it to revoke that authorization.
No workflow sets this variable. With it unset, each public release needs a separate authorized
stable dispatch with `publish` checked and the exact locally accepted build-only run ID.

## Automation prerequisites

The automation fails closed until these GitHub settings are configured by a repository maintainer;
this implementation does not change repository settings:

- Configure classic branch protection for `main` with strict/up-to-date required status checks for
  the four fork CI jobs above, sourced from the GitHub Actions app (app id `15368`). Leave
  administrator enforcement disabled so maintainers can push directly to `main`. Require no
  additional PR approval and allow merge commits. If a repository ruleset applies, its bypass
  actors may only be repository admins
  (`actor_type: "RepositoryRole"`, `actor_id: 5`) or organization admins
  (`actor_type: "OrganizationAdmin"`). Do not add an integration, team, user, or other bypass
  actor. A ruleset alone does not satisfy the workflow's required-check preflight.
- Add Actions secrets `FORK_SYNC_APP_ID` and `FORK_SYNC_APP_PRIVATE_KEY` for a GitHub App installed
  only on `get-aix/t3code`, with exactly `actions:write`, `administration:read`, `contents:write`,
  `pull_requests:write`, and `workflows:write`. Administration read inspects branch protection and rulesets. Contents
  and pull-request write push the sync branch and open and merge its PR. Actions write lets the
  main-CI completion job dispatch the existing `Release` workflow. Workflows write lets the
  publisher set the release tag and `release` branch on a source commit whose workflow files differ
  from `main`, which `GITHUB_TOKEN` refuses. The branch-creation token is scoped to
  administration, contents, and pull requests. The App must not have repository administrator access and must not be a
  ruleset bypass actor.
- The merge job uses the App token for the protected merge; the main-CI completion job uses it for
  release dispatch. Their `GITHUB_TOKEN`
  is limited to contents read for checkout; the release publisher requests `contents:write`. The
  repository's read-only default can remain in place because each job declares its own scoped
  permissions. The workflow does not approve pull requests or use GitHub's auto-merge setting.
- Keep `FORK_AUTO_PUBLISH_STABLE_RELEASES` unset until ongoing automatic publication is explicitly
  authorized. Setting it to `true` is that standing authorization. The default workflow and
  build-only path do not create tags or draft releases.

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

  `upstream/main` is used here only to find a read-only comparison base; it is never merged into
  fork `main`.

  Expected hits are test sentinels, the `/home/user` fixture paths, and the keystore steps in the
  Android workflow and guide. Anything else needs a look before releasing.

- The standalone Android workflow uploads only the APK, its checksum, and `metadata.json`. The
  combined release artifact also contains the desktop installers, update feeds, and Nix verification record.

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

The clone contains an imported upstream `v0.1.9` tag. It is not a fork release, and it must not
be moved, deleted, or force-pushed. Current `main` already includes upstream commit
`f82162f0336c226ae1f2927f781a0fb660869a51`, which is beyond `v0.1.9`, so the first release must
wait for and sync the first upstream stable tag that contains every upstream commit already in
`main`. Start `Release` manually from a reviewed, green `main` commit
with `publish` unchecked to build the Windows installer, signed APK, and same-version Nix package.
Download the resulting Actions artifact and test it locally. No tag or release is created by this
step. After explicit authorization, dispatch the stable workflow for the reviewed exact source with
`publish` checked and `artifact_run_id` set to the accepted build-only run. It creates
`vX.Y.Z` titled `T3 Code vX.Y.Z` from those same tested installer bytes. This first successful
publication also creates the `release` branch. Later publications move it only when the new release
is a fast-forward; publishing an older release leaves it unchanged. The branch never force-moves.
Use `github:get-aix/t3code/release` to follow the latest published Nix build, or pin a release tag
for reproducibility. `main` includes unreleased fork changes. The notes identify the fork commit,
source branch, upstream base, and build-only run, and the Nix command resolves the fork repository.

Publishing reserves the tag before it creates the release. If a publish run fails between the
two, the tag remains without a release and blocks that version for every source commit. Confirm on
the Releases page that `vX.Y.Z` has no release, delete only that tag with
`gh api -X DELETE repos/get-aix/t3code/git/refs/tags/vX.Y.Z`, then rerun the publish dispatch.

The `Nitestack Android APK` workflow remains available for a standalone signed build artifact. Its
legacy `t3-android-vMAJOR.MINOR.PATCH` tag route remains compatible; use the `Release` workflow for
the Windows, Android, and Nix build-only artifact or for an authorized canonical fork release.
