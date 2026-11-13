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
  const openSyncPullRequest = openSyncPullRequests.find(
    ({ headRefName }) => typeof headRefName === "string" && headRefName.startsWith(BRANCH_PREFIX),
  );
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
      "headRefName,title,url",
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
  const releases = getPublishedReleases();
  if (releases.length === 0) throw new Error("Upstream releases API returned no releases.");
  const stableReleases = releases.filter(isStableRelease);
  if (stableReleases.length === 0)
    throw new Error("Upstream releases API returned no published stable SemVer releases.");

  const openSyncPullRequests = getOpenSyncPullRequests();
  const mainRef = "refs/remotes/origin/main";
  git(["fetch", "origin", "main"]);
  git(["fetch", "--no-tags", UPSTREAM_URL, "+refs/tags/*:refs/tags/upstream/*"]);

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
    openSyncPullRequests,
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
  const dryRun = process.env.DRY_RUN === "true";

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
    "- Fork CI covers server, web, desktop build, and mobile type/unit checks. GitHub may hold pull request runs created with `GITHUB_TOKEN` for maintainer approval; use the `CI` workflow's `workflow_dispatch` on this branch to start the checks explicitly.",
  ].join("\n");
  if (dryRun) {
    const summary = `## Upstream stable sync: ${targetTag}\n\n${changeSummary}\n\nDry run only; no branch was pushed and no pull request was created.`;
    console.log(summary);
    await writeStepSummary(summary);
    return;
  }
  const bodyPath = `${process.env.RUNNER_TEMP ?? "/tmp"}/upstream-stable-sync-pr.md`;
  await NodeFSP.writeFile(bodyPath, `${body}\n`);
  git(["push", "origin", `HEAD:refs/heads/${branch}`]);
  const pullRequestUrl = run(
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
  const summary = `## Upstream stable sync: ${targetTag}\n\n${changeSummary}\n\nCreated a review pull request: ${pullRequestUrl}\n\nNo merge or release was performed.`;
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
