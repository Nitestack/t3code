# T3 Code fork

This fork keeps T3's provider, thread, and client behavior aligned with upstream. It keeps the
upstream application version and uses the same `vX.Y.Z` tag and `T3 Code vX.Y.Z` release title for
reviewed fork releases.

## Verified starting point

GitHub identifies `Nitestack/t3code` as a public fork of `pingdotgg/t3code`, with `main` as its
default branch. The checkout's `origin` points to the fork and `upstream` points to the original
repository. `gh` uses `Nitestack/t3code` as its local default. The fork history includes upstream
commits beyond the imported `v0.1.9` stable tag, so the sync automation waits for a stable tag that
contains them before creating the first release.

## Bootstrap from an upstream clone

Run these commands from a fresh clone of `pingdotgg/t3code`. They verify the account and both
repositories before a remote is changed.

```sh
gh auth status
OWNER="$(gh api user --jq .login)"
gh repo view pingdotgg/t3code --json nameWithOwner,defaultBranchRef,isFork,parent
gh repo view "$OWNER/t3code" --json nameWithOwner,defaultBranchRef,isFork,parent
git status --short --branch
git remote -v
```

Confirm the authenticated owner is the intended fork owner, and that an existing
`$OWNER/t3code` is a fork whose parent is `pingdotgg/t3code`. If the fork query returns 404, create
the fork once from this upstream clone:

```sh
gh repo fork --clone=false --remote=true
```

Do not run the creation command if the fork already exists. The CLI reuses the current clone,
renames its upstream `origin` to `upstream`, and adds the fork as `origin`. If the fork already
exists, keep its valid `origin`; add `upstream` only when absent:

```sh
git remote add upstream git@github.com:pingdotgg/t3code.git
```

If `origin` already points to `$OWNER/t3code`, leave it unchanged. If it still points to the verified
upstream clone, change it to the verified fork URL. Stop if either remote points somewhere
unexpected. For a verified upstream `origin`, run:

```sh
git remote set-url origin "git@github.com:${OWNER}/t3code.git"
```

Then verify the state and set the local `gh` default explicitly to the fork:

```sh
git remote -v
git remote get-url origin
git remote get-url upstream
gh repo set-default "$OWNER/t3code"
gh repo set-default --view
```

When `origin` is already a valid fork and `upstream` is correct, no remote mutation is needed.
Always pass `--repo OWNER/t3code` to later mutating `gh` commands.

## Branches, versions, and upstream review

Work from the fork's `main`; use `feature/<topic>`, `fix/<topic>`, or `chore/<topic>` branches and
open PRs against the fork's `main`. Use conventional commit titles. The daily stable sync opens a
PR for a newer upstream release and merges it only after all four exact-head fork CI jobs succeed
under protected `main`. Conflicts or stale checks leave the sync unmerged for manual repair.

Fork `main` takes only published upstream stable tags; never merge upstream `main`. A stable tag is
skipped until it contains every upstream commit already present in fork `main`, so the first release
can happen only at the first stable tag that contains all commits already merged there.

The fork keeps the upstream application version values. The existing `Release` workflow from
`main` checks all four fork CI jobs on the exact source commit, confirms the application manifests
agree, and builds a Windows x64 installer, signed Android APK, and matching Nix package. Its default
build-only mode uploads an Actions artifact without creating a tag or release. After explicit
authorization, a stable dispatch can publish the upstream-matched `vX.Y.Z` tag and `T3 Code vX.Y.Z`
release. The tag points to the fork integration merge commit on `main`: its tree includes fork changes
and upstream through the matching stable tag. The upstream tag's peeled commit is recorded only as
the stable base. Notes and artifact metadata show both full SHAs, and the Nix command pins to the fork
release tag.
The old imported tag in this clone is not a fork release: the workflow refuses to move it or replace
an existing release.

To inspect upstream changes manually without applying them:

```sh
git fetch upstream --tags
gh api repos/pingdotgg/t3code/releases/latest \
  --jq '{tag_name, target_commitish, draft, prerelease, published_at}'
```

`releases/latest` selects GitHub's latest stable release. To resolve its exact commit after fetching
tags, use `git rev-parse '<tag>^{commit}'`. Review that stable tag and its CI before syncing it;
upstream `main` is not a sync source.

## Local development and separate server data

Install the repository's pinned toolchain and dependencies with `vp i`, then start the combined
server and web client with `vp run dev`. The runner prints the actual server and web ports. In a
worktree, dev state defaults to that worktree's ignored `.t3/userdata`; an explicit `--home-dir`
overrides it.

When running an original checkout and the fork at the same time, use separate data directories and
port offsets. For example, the default ports are server `13773` and web `5733`; offset `200` gives
the fork its own pair. Start each command in its own terminal:

```sh
# Original checkout
T3CODE_PORT_OFFSET=0 vp run dev --home-dir "$HOME/.t3/original"

# Fork checkout
T3CODE_PORT_OFFSET=200 vp run dev --home-dir "$HOME/.t3/fork"
```

Keep the directories separate for desktop, web, and remote connections to each server. The
work/personal view is not a data-isolation boundary.

## Build and CI baseline

`CI` runs upstream-only jobs only in `pingdotgg/t3code`. On fork pull requests and pushes to
`main`, separate jobs run on
GitHub-hosted `ubuntu-latest` runners without upstream secrets, Blacksmith runners, store
publishing, or iOS builds:

| Surface | Fork CI checks                                          | Local command                                                                          |
| ------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Server  | Typecheck and server tests                              | `vp run --filter t3 typecheck` and `vp run --filter t3 test`                           |
| Web     | Production build and web tests                          | `vp run --filter @t3tools/web build` and `vp run --filter @t3tools/web test`           |
| Desktop | Linux desktop pipeline build and preload verification   | `vp run --filter @t3tools/desktop ensure:electron`, then `vp run build:desktop`        |
| Mobile  | Typecheck and unit/React test projects; no native build | `vp run --filter @t3tools/mobile typecheck` and `vp run --filter @t3tools/mobile test` |

The mobile test task runs the unit and React projects. The signed Android APK has its own workflow,
described in the [Android APK guide](../operations/android-fork-apk.md); the stable release workflow
also builds the Windows installer and Nix package. This fork does not build iOS. Releases follow the
[fork release runbook](../operations/fork-release.md). Local mobile development may still use an
existing development client and Metro as described in [the mobile guide](../../apps/mobile/README.md).

The fork's `CI` workflow keeps its upstream jobs behind `github.repository == 'pingdotgg/t3code'`.
This job-level guard also protects reusable workflows and triggers such as `workflow_dispatch`,
`schedule`, `release`, `workflow_run`, and `pull_request_target`. New upstream-only jobs must carry
the same guard. Fork baseline jobs and the fork release use standard GitHub runners. The release
workflow passes only the four Android signing secrets to the reusable APK build; Windows and Nix
builds receive no upstream signing, publishing, or deployment credentials. Upstream release and
deploy jobs remain repository-guarded.
