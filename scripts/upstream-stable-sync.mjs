import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

const FORK_REPOSITORY = "Nitestack/t3code";
const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";
const MARKER_PATH = ".github/upstream-stable.json";
const BRANCH_PREFIX = "automation/upstream-stable-";

const TEST_RELEASE_LABEL =
  /\b(?:test(?:ing)?|maintainer|preview|nightly|alpha|beta|rc|canary|development)\b/i;

export function parseStableVersion(tag) {
  if (typeof tag !== "string") return undefined;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  return match ? match.slice(1).map(BigInt) : undefined;
}

function compareVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  if (!leftParts || !rightParts) throw new Error("Expected stable SemVer tags.");
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export function isStableRelease(release) {
  if (!release || release.draft !== false || release.prerelease !== false) return false;
  if (!parseStableVersion(release.tag_name)) return false;
  return !TEST_RELEASE_LABEL.test(`${release.tag_name} ${release.name ?? ""}`);
}

export function getSyncDecision(
  releases,
  { integratedTag, targetTag, openSyncPullRequests = [] } = {},
) {
  const openSyncPullRequest = getSyncPullRequests(openSyncPullRequests)[0];
  if (openSyncPullRequest) {
    return { kind: "duplicate", branch: openSyncPullRequest.headRefName };
  }

  const stable = releases
    .filter(isStableRelease)
    .sort((left, right) => compareVersions(right.tag_name, left.tag_name));
  for (let index = 1; index < stable.length; index += 1) {
    if (compareVersions(stable[index - 1].tag_name, stable[index].tag_name) === 0) {
      throw new Error(`Multiple published stable releases use SemVer ${stable[index].tag_name}.`);
    }
  }
  if (stable.length === 0)
    throw new Error("Upstream returned no published stable SemVer releases.");

  const release =
    targetTag === undefined
      ? stable[0]
      : stable.find((candidate) => candidate.tag_name === targetTag);
  if (!release)
    throw new Error(`Target tag is not a published stable SemVer release: ${targetTag}`);

  if (integratedTag !== undefined && compareVersions(release.tag_name, integratedTag) <= 0) {
    return { kind: "up-to-date", tag: integratedTag };
  }
  return { kind: "update", release };
}

export function classifyGitHubFailure(stderr) {
  const message = String(stderr ?? "");
  if (/rate limit exceeded|secondary rate limit|abuse detection/i.test(message)) {
    return "GitHub API rate limit reached while checking upstream releases or pull requests; retry later.";
  }
  if (/\b404\b|not found/i.test(message)) {
    return "GitHub returned 404 while checking upstream releases or pull requests; verify repository access and the API endpoint.";
  }
  return "GitHub request failed while checking upstream releases or pull requests.";
}

export function mergeStableRelease({ targetTag, mainRef, branch, tagRef, cwd = process.cwd() }) {
  const runGit = (args, options) => git(args, { ...options, cwd });
  runGit(["switch", "--create", branch, mainRef]);
  try {
    runGit(["merge", "--no-edit", "--no-ff", "--no-commit", tagRef]);
  } catch (error) {
    const conflicts =
      runGit(["diff", "--name-only", "--diff-filter=U"], { allowFailure: true }) ?? "";
    throw new Error(
      `Could not merge upstream stable tag ${targetTag}; conflict or merge failure. ${conflicts ? `Resolve these paths in a reviewed update: ${conflicts.replaceAll("\n", ", ")}` : "No changes were committed or pushed."}`,
      { cause: error },
    );
  }
}

function run(
  command,
  args,
  { githubRequest = false, cwd = process.cwd(), allowFailure = false } = {},
) {
  try {
    return NodeChildProcess.execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return undefined;
    if (githubRequest) throw new Error(classifyGitHubFailure(error.stderr), { cause: error });
    const detail = String(error.stderr ?? error.message ?? "")
      .trim()
      .split("\n")
      .at(-1);
    throw new Error(`${command} failed${detail ? `: ${detail}` : "."}`, { cause: error });
  }
}

function git(args, options) {
  return run("git", args, options);
}

function getRemoteBranchCommit(branch) {
  const ref = `refs/heads/${branch}`;
  const result = git(["ls-remote", "--heads", "origin", ref]);
  if (!result) return undefined;
  const matches = result.split("\n").filter(Boolean);
  if (matches.length !== 1) throw new Error(`Remote sync branch ${branch} is ambiguous.`);
  const [commit, remoteRef] = matches[0].split("\t");
  if (!/^[0-9a-f]{40,64}$/i.test(commit) || remoteRef !== ref) {
    throw new Error(`Remote sync branch ${branch} returned an invalid ref.`);
  }
  git(["fetch", "origin", ref]);
  const fetchedCommit = git(["rev-parse", "FETCH_HEAD"]);
  if (fetchedCommit !== commit) {
    throw new Error(`Remote sync branch ${branch} changed while it was being inspected.`);
  }
  return commit;
}

function validateSyncBranch({ branch, branchCommit, mainRef, targetTag, targetCommit }) {
  const expectedMarker = `${JSON.stringify({ tag: targetTag, commit: targetCommit }, null, 2)}\n`;
  const marker = `${branchCommit}:${MARKER_PATH}`;
  let actualMarker;
  try {
    actualMarker = git(["show", marker]);
  } catch {
    throw new Error(`Existing update branch ${branch} is missing its upstream marker.`);
  }
  if (actualMarker !== expectedMarker.trimEnd()) {
    throw new Error(`Existing update branch ${branch} has an unexpected upstream marker.`);
  }

  const mergeParents = git(["show", "-s", "--format=%P", branchCommit]).split(" ");
  if (mergeParents.length !== 2 || mergeParents[1] !== targetCommit) {
    throw new Error(
      `Existing update branch ${branch} contains unexpected commits or does not merge the expected upstream tag.`,
    );
  }
  if (!isAncestor(mergeParents[0], mainRef)) {
    throw new Error(
      `Existing update branch ${branch} is not based on the current fork main history.`,
    );
  }
  let expectedMergeTree;
  try {
    expectedMergeTree = git(["merge-tree", "--write-tree", mergeParents[0], targetCommit])
      .split("\n")[0]
      .trim();
  } catch {
    throw new Error(`Existing update branch ${branch} contains an unresolved upstream merge.`);
  }
  const mergeChanges = git(["diff", "--name-only", expectedMergeTree, branchCommit])
    .split("\n")
    .filter(Boolean);
  if (mergeChanges.length !== 1 || mergeChanges[0] !== MARKER_PATH) {
    throw new Error(
      `Existing update branch ${branch} contains unexpected fork changes or merge resolutions.`,
    );
  }
}

function getSyncPullRequests(pullRequests) {
  return pullRequests.filter(
    ({ headRefName, headRepository }) =>
      typeof headRefName === "string" &&
      headRefName.startsWith(BRANCH_PREFIX) &&
      typeof headRepository?.nameWithOwner === "string" &&
      headRepository.nameWithOwner.toLowerCase() === FORK_REPOSITORY.toLowerCase(),
  );
}

function releaseFromBranch(branch, releases) {
  const match =
    /^automation\/upstream-stable-(v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([0-9a-f]{8})$/.exec(
      branch,
    );
  if (!match)
    throw new Error(`Existing sync pull request has an unexpected branch name: ${branch}`);
  const release = releases.find(
    (candidate) => candidate.tag_name === match[1] && isStableRelease(candidate),
  );
  if (!release)
    throw new Error(`Existing sync branch ${branch} does not match a published stable release.`);
  return { release, commitPrefix: match[2] };
}

function findWorkflowDispatch(branch) {
  let runs;
  try {
    runs = JSON.parse(
      run(
        "gh",
        [
          "run",
          "list",
          "--repo",
          FORK_REPOSITORY,
          "--workflow",
          "ci.yml",
          "--branch",
          branch,
          "--event",
          "workflow_dispatch",
          "--limit",
          "1",
          "--json",
          "databaseId,status,conclusion",
        ],
        { githubRequest: true },
      ),
    );
  } catch (error) {
    throw new Error(`Could not check whether fork CI was already dispatched for ${branch}.`, {
      cause: error,
    });
  }
  if (!Array.isArray(runs)) throw new Error("GitHub returned invalid workflow run data.");
  return runs.length > 0;
}

function dispatchForkCi(branch) {
  if (findWorkflowDispatch(branch)) return false;
  try {
    run(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `repos/${FORK_REPOSITORY}/actions/workflows/ci.yml/dispatches`,
        "-f",
        `ref=${branch}`,
      ],
      { githubRequest: true },
    );
  } catch (error) {
    const details = `${error.message} ${error.cause?.message ?? ""} ${error.cause?.stderr ?? ""}`;
    if (
      /HTTP 403|resource not accessible by integration|permission.*actions|actions.*permission/i.test(
        details,
      )
    ) {
      throw new Error(
        `GitHub denied CI dispatch for ${branch}. The sync job declares actions:write; a maintainer must allow that token permission. The update branch and pull request are preserved for retry.`,
        { cause: error },
      );
    }
    throw new Error(
      `Could not dispatch fork CI for ${branch}. The update branch and pull request are preserved; retrying will recover this dispatch.`,
      { cause: error },
    );
  }
  return true;
}

function createSyncPullRequest(branch, targetTag, bodyPath) {
  try {
    return run(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        FORK_REPOSITORY,
        "--base",
        "main",
        "--head",
        `Nitestack:${branch}`,
        "--title",
        `chore: sync upstream stable ${targetTag}`,
        "--body-file",
        bodyPath,
      ],
      { githubRequest: true },
    );
  } catch (error) {
    const stderr = String(error.cause?.stderr ?? error.message ?? "");
    if (
      /not permitted|not allowed|resource not accessible by integration|pull requests.*disabled|HTTP 403/i.test(
        stderr,
      )
    ) {
      throw new Error(
        `GitHub blocked automated pull-request creation. A maintainer must allow GitHub Actions to create pull requests in the repository Actions policy. The update branch ${branch} is preserved; retry after that policy change.`,
        { cause: error },
      );
    }
    throw new Error(
      `GitHub rejected pull-request creation. The update branch ${branch} is preserved for retry.`,
      { cause: error },
    );
  }
}

function resolveTagCommit(tag) {
  const ref = `refs/tags/upstream/${tag}^{commit}`;
  const commit = git(["rev-parse", "--verify", ref], { allowFailure: true });
  if (!commit) throw new Error(`Upstream release tag ${tag} could not be resolved to a commit.`);
  return commit;
}

function isAncestor(commit, ref) {
  try {
    NodeChildProcess.execFileSync("git", ["merge-base", "--is-ancestor", commit, ref], {
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw new Error(`Could not compare upstream commit ${commit} with ${ref}.`, { cause: error });
  }
}

function readIntegratedMarker(mainRef, releases) {
  const markerRef = `${mainRef}:${MARKER_PATH}`;
  const exists = git(["cat-file", "-t", markerRef], { allowFailure: true });
  if (!exists) return undefined;
  let marker;
  try {
    marker = JSON.parse(git(["show", markerRef]));
  } catch {
    throw new Error(`The integrated upstream marker at ${MARKER_PATH} is invalid.`);
  }
  if (typeof marker.tag !== "string" || typeof marker.commit !== "string") {
    throw new Error(
      `The integrated upstream marker at ${MARKER_PATH} is missing its tag or commit.`,
    );
  }
  if (!releases.some((release) => release.tag_name === marker.tag && isStableRelease(release))) {
    throw new Error(
      `Integrated upstream tag ${marker.tag} is missing from the published stable release list.`,
    );
  }
  const expectedCommit = resolveTagCommit(marker.tag);
  if (expectedCommit !== marker.commit || !isAncestor(marker.commit, mainRef)) {
    throw new Error(
      `Integrated upstream marker for ${marker.tag} does not match the main branch history.`,
    );
  }
  return marker;
}

function getPublishedReleases() {
  const output = run(
    "gh",
    ["api", "--paginate", "--slurp", `repos/${UPSTREAM_REPOSITORY}/releases?per_page=100`],
    { githubRequest: true },
  );
  let pages;
  try {
    pages = JSON.parse(output);
  } catch {
    throw new Error("GitHub returned invalid JSON for the upstream releases API.");
  }
  if (!Array.isArray(pages))
    throw new Error("GitHub returned an unexpected upstream releases response.");
  const releases = pages.flat(Infinity);
  if (!releases.every((release) => release && typeof release === "object")) {
    throw new Error("GitHub returned an unexpected upstream release entry.");
  }
  return releases;
}

function getOpenSyncPullRequests() {
  const output = run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      FORK_REPOSITORY,
      "--state",
      "open",
      "--base",
      "main",
      "--json",
      "headRefName,headRepository,title,url",
      "--limit",
      "1000",
    ],
    { githubRequest: true },
  );
  try {
    const pullRequests = JSON.parse(output);
    if (!Array.isArray(pullRequests)) throw new Error("not an array");
    return pullRequests;
  } catch {
    throw new Error(
      "GitHub returned invalid JSON while checking for an existing upstream-sync pull request.",
    );
  }
}

function requireFork() {
  if (process.env.GITHUB_REPOSITORY?.toLowerCase() !== FORK_REPOSITORY.toLowerCase()) {
    throw new Error(
      `Upstream stable sync only runs in the explicitly guarded fork ${FORK_REPOSITORY}.`,
    );
  }
  const origin = git(["remote", "get-url", "origin"]);
  if (!/github\.com[:/]Nitestack\/t3code(?:\.git)?$/i.test(origin)) {
    throw new Error(`The origin remote must point to ${FORK_REPOSITORY}; refusing to push.`);
  }
}

function writeStepSummary(message) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) return NodeFSP.writeFile(summaryPath, `${message}\n`, { flag: "a" });
  return Promise.resolve();
}

async function main() {
  requireFork();
  const dryRun = process.env.DRY_RUN === "true";
  const releases = getPublishedReleases();
  if (releases.length === 0) throw new Error("Upstream releases API returned no releases.");
  const stableReleases = releases.filter(isStableRelease);
  if (stableReleases.length === 0)
    throw new Error("Upstream releases API returned no published stable SemVer releases.");

  const openSyncPullRequests = getOpenSyncPullRequests();
  const mainRef = "refs/remotes/origin/main";
  git(["fetch", "origin", "main"]);
  git(["fetch", "--no-tags", UPSTREAM_URL, "+refs/tags/*:refs/tags/upstream/*"]);

  const syncPullRequests = getSyncPullRequests(openSyncPullRequests);
  if (syncPullRequests.length > 1) {
    throw new Error(
      "Multiple upstream stable-sync pull requests are open; refusing to create another.",
    );
  }
  if (syncPullRequests.length === 1) {
    const { headRefName: branch } = syncPullRequests[0];
    const { release, commitPrefix } = releaseFromBranch(branch, releases);
    const targetCommit = resolveTagCommit(release.tag_name);
    if (!targetCommit.startsWith(commitPrefix)) {
      throw new Error(`Existing sync branch ${branch} does not match the release tag commit.`);
    }
    const branchCommit = getRemoteBranchCommit(branch);
    if (!branchCommit)
      throw new Error(`Open sync pull request branch ${branch} is missing from origin.`);
    validateSyncBranch({
      branch,
      branchCommit,
      mainRef,
      targetTag: release.tag_name,
      targetCommit,
    });
    if (dryRun) {
      const message = `Dry run only; existing sync pull request ${branch} verified without dispatching CI.`;
      console.log(message);
      await writeStepSummary(message);
      return;
    }
    const dispatched = dispatchForkCi(branch);
    const message = dispatched
      ? `Existing sync pull request ${branch} verified; fork CI was dispatched on that branch.`
      : `Existing sync pull request ${branch} verified; fork CI already has a workflow_dispatch run.`;
    console.log(message);
    await writeStepSummary(message);
    return;
  }

  const marker = readIntegratedMarker(mainRef, stableReleases);
  const integratedRelease = marker
    ? { tag: marker.tag, commit: marker.commit }
    : stableReleases
        .filter((release) => isAncestor(resolveTagCommit(release.tag_name), mainRef))
        .sort((left, right) => compareVersions(right.tag_name, left.tag_name))[0];
  const integratedTag = integratedRelease?.tag_name ?? integratedRelease?.tag;
  const decision = getSyncDecision(releases, {
    integratedTag,
    targetTag: process.env.TARGET_TAG || undefined,
  });

  if (decision.kind === "duplicate") {
    const message = `Skipped: an upstream stable-sync pull request is already open from \`${decision.branch}\`.`;
    console.log(message);
    await writeStepSummary(message);
    return;
  }
  if (decision.kind === "up-to-date") {
    const message = `Up to date through upstream stable tag \`${decision.tag}\`; no pull request created.`;
    console.log(message);
    await writeStepSummary(message);
    return;
  }

  const targetTag = decision.release.tag_name;
  const targetCommit = resolveTagCommit(targetTag);
  if (git(["cat-file", "-t", `${targetCommit}:${MARKER_PATH}`], { allowFailure: true })) {
    throw new Error(
      `Upstream already uses ${MARKER_PATH}; refusing to overwrite it with fork sync state.`,
    );
  }
  if (isAncestor(targetCommit, mainRef)) {
    const message = `Upstream tag \`${targetTag}\` is already in the fork history; no pull request created.`;
    console.log(message);
    await writeStepSummary(message);
    return;
  }

  const baseCommit =
    integratedRelease?.commit ??
    (integratedTag ? resolveTagCommit(integratedTag) : git(["merge-base", mainRef, targetCommit]));
  const branch = `${BRANCH_PREFIX}${targetTag}-${targetCommit.slice(0, 8)}`;

  const existingBranchCommit = getRemoteBranchCommit(branch);
  if (existingBranchCommit) {
    validateSyncBranch({
      branch,
      branchCommit: existingBranchCommit,
      mainRef,
      targetTag,
      targetCommit,
    });
  } else {
    git(["config", "user.name", "github-actions[bot]"]);
    git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    mergeStableRelease({
      targetTag,
      mainRef,
      branch,
      tagRef: `refs/tags/upstream/${targetTag}`,
    });

    await NodeFSP.writeFile(
      MARKER_PATH,
      `${JSON.stringify({ tag: targetTag, commit: targetCommit }, null, 2)}\n`,
    );
    git(["add", "--", MARKER_PATH]);
    git(["commit", "--no-edit", "-m", `chore: sync upstream stable ${targetTag}`]);
  }

  const commits = git(["log", "--format=%s (%h)", `${baseCommit}..${targetCommit}`])
    .split("\n")
    .filter(Boolean);
  const changeSummary =
    commits.length > 0
      ? `${commits
          .slice(0, 60)
          .map((commit) => `- ${commit}`)
          .join(
            "\n",
          )}${commits.length > 60 ? `\n- … and ${commits.length - 60} more upstream commits` : ""}`
      : "No upstream commit messages were found between the recorded stable tags.";
  const body = [
    `This pull request merges upstream stable release **${targetTag}** (${targetCommit}).`,
    "",
    "The update branch is based on the fork's current `main` and merges the upstream tag, preserving fork commits. Review the diff and wait for the fork CI checks before merging. This workflow never enables auto-merge.",
    "",
    "### Upstream change summary",
    changeSummary,
    "",
    "### Verification",
    "- The sync workflow dispatches Fork CI on this exact branch and fails if dispatch is rejected. Confirm a CI run exists and passes before merging; this workflow never approves or merges the pull request.",
  ].join("\n");
  if (dryRun) {
    const summary = `## Upstream stable sync: ${targetTag}\n\n${changeSummary}\n\nDry run only; no branch was pushed and no pull request was created.`;
    console.log(summary);
    await writeStepSummary(summary);
    return;
  }
  const bodyPath = `${process.env.RUNNER_TEMP ?? "/tmp"}/upstream-stable-sync-pr.md`;
  await NodeFSP.writeFile(bodyPath, `${body}\n`);
  if (!existingBranchCommit) git(["push", "origin", `HEAD:refs/heads/${branch}`]);
  const pullRequestUrl = createSyncPullRequest(branch, targetTag, bodyPath);
  const dispatched = dispatchForkCi(branch);
  const summary = `## Upstream stable sync: ${targetTag}\n\n${changeSummary}\n\nCreated a review pull request: ${pullRequestUrl}\n\nFork CI ${dispatched ? "was dispatched" : "already has a workflow_dispatch run"} on ${branch}. No merge or release was performed.`;
  console.log(summary);
  await writeStepSummary(summary);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    const message =
      error instanceof Error ? error.message : "Unknown upstream stable sync failure.";
    console.error(message);
    await writeStepSummary(`## Upstream stable sync failed\n\n${message}`).catch(() => {});
    process.exitCode = 1;
  });
}
