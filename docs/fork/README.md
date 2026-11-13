# T3 Code fork

This fork keeps T3's provider, thread, and client behavior aligned with upstream. Fork-only
development is identified by its Git commit; do not change upstream product versions or publish
upstream-style `vX.Y.Z` tags from the fork.

## Verified starting point

The ticket branch started from `daed91f26464a280796e38911b7b97455226ef9e`, which was also
`origin/main` at bootstrap. GitHub identifies `Nitestack/t3code` as a public fork of
`pingdotgg/t3code`, with `main` as its default branch. The checkout's `origin` points to the fork
and `upstream` points to the original repository. `gh` uses `Nitestack/t3code` as its local default.

The latest stable upstream release at bootstrap was `v0.1.9`, published on 2026-11-11 and pointing
to `24e77473ecf41bc1f7142529c7911c1c1aae1d76`. GitHub's compare API reported the checkout base
974 commits ahead of that release and zero commits behind. At bootstrap, the checkout was based on
upstream `main`, not that older stable tag. During the T00 implementation, upstream `main` was
`065aca4889fb422c536bbf673d2f2beba50df3cb`, three commits ahead of the ticket base.

Recheck these values before a future upstream sync; they describe the bootstrap, not a moving
version pin.

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
open PRs against the fork's `main`. Use conventional commit titles. Do not merge upstream changes
blindly: T17 owns the automated stable-release check and reviewable sync process.

The fork keeps upstream's application version values while developing and identifies builds by
commit SHA. Do not create upstream-style `vX.Y.Z` tags or releases in the fork. A future fork release
must use a separate fork-prefixed version/tag scheme and its own explicit release workflow.

To inspect upstream changes manually without applying them:

```sh
git fetch upstream --tags
gh api repos/pingdotgg/t3code/releases/latest \
  --jq '{tag_name, target_commitish, draft, prerelease, published_at}'
git log --oneline --decorate --left-right origin/main...upstream/main
```

`releases/latest` selects GitHub's latest stable release. To resolve its exact commit after fetching
tags, use `git rev-parse '<tag>^{commit}'`. Review the commit range and CI before syncing it.

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

The mobile test task runs the unit and React projects. Android APK production is deferred to T16;
this fork does not build iOS. Local mobile development may still use an existing development client
and Metro as described in [the mobile guide](../../apps/mobile/README.md).

The fork's `CI` workflow keeps its upstream jobs behind `github.repository == 'pingdotgg/t3code'`.
This job-level guard also protects reusable workflows and triggers such as `workflow_dispatch`,
`schedule`, `release`, `workflow_run`, and `pull_request_target`. New upstream-only jobs must carry
the same guard. Fork baseline jobs use standard GitHub runners and need no maintainer credentials.
