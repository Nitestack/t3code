import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import ForkCiChecks from "../.github/scripts/fork-ci-checks.cjs";
import { releasePackageFiles } from "./lib/tagged-source-version.ts";

const FORK_REPOSITORY = "get-aix/t3code";
const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";
const MARKER_PATH = ".github/upstream-stable.json";
const BRANCH_PREFIX = "automation/upstream-stable-";
const REPOSITORY_ADMIN_ROLE_ID = 5;
const RULESET_BYPASS_MODES = new Set(["always", "pull_request", "exempt"]);
const { REQUIRED_FORK_CHECKS, selectLatestForkCiRun, validateForkCiCompletion, validateForkCiRun } =
  ForkCiChecks;
const GITHUB_OPERATION_LABELS = new Map([
  ["upstreamReleases", "upstream releases lookup"],
  ["openSyncPullRequests", "open sync pull-request lookup"],
  ["workflowRuns", "CI workflow-run lookup"],
  ["workflowDispatch", "CI workflow dispatch"],
  ["createSyncPullRequest", "sync pull-request creation"],
  ["branchProtection", "main branch protection lookup"],
  ["repositoryRulesets", "repository branch ruleset lookup"],
  ["repositorySettings", "repository merge-setting lookup"],
  ["syncPullRequestMerge", "sync pull-request merge"],
]);

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

export function findUpstreamCommitsAlreadyInForkMain({ forkMainCommits, upstreamMainCommits }) {
  if (!Array.isArray(forkMainCommits) || !Array.isArray(upstreamMainCommits)) {
    throw new Error("Fork main and upstream main histories must be commit lists.");
  }
  if (
    [...forkMainCommits, ...upstreamMainCommits].some(
      (commit) => typeof commit !== "string" || !/^[0-9a-f]{40}$/i.test(commit),
    )
  ) {
    throw new Error("Fork main and upstream main histories contain an invalid commit SHA.");
  }
  const forkMain = new Set(forkMainCommits.map((commit) => commit.toLowerCase()));
  return [...new Set(upstreamMainCommits.map((commit) => commit.toLowerCase()))]
    .filter((commit) => forkMain.has(commit))
    .toSorted();
}

export function findUpstreamCommitsMissingFromStableTag({
  upstreamCommitsPresentInMain,
  stableTagCommits,
}) {
  if (!Array.isArray(upstreamCommitsPresentInMain) || !Array.isArray(stableTagCommits)) {
    throw new Error("Fork main and stable tag histories must be commit lists.");
  }
  if (
    [...upstreamCommitsPresentInMain, ...stableTagCommits].some(
      (commit) => typeof commit !== "string" || !/^[0-9a-f]{40}$/i.test(commit),
    )
  ) {
    throw new Error("Fork main and stable tag histories contain an invalid commit SHA.");
  }
  const stableTagHistory = new Set(stableTagCommits.map((commit) => commit.toLowerCase()));
  return [...new Set(upstreamCommitsPresentInMain.map((commit) => commit.toLowerCase()))]
    .filter((commit) => !stableTagHistory.has(commit))
    .toSorted();
}

export function getSyncDecision(
  releases,
  {
    integratedTag,
    targetTag,
    openSyncPullRequests = [],
    compatibleTags,
    upstreamCommitsPresentInMain = [],
    missingUpstreamCommitsByTag = {},
  } = {},
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
  if (stable.length === 0) {
    if (targetTag === undefined) return { kind: "no-releases" };
    throw new Error("Target tag is not a published stable SemVer release: " + targetTag);
  }

  const explicitRelease =
    targetTag === undefined
      ? undefined
      : stable.find((candidate) => candidate.tag_name === targetTag);
  if (targetTag !== undefined && !explicitRelease)
    throw new Error(`Target tag is not a published stable SemVer release: ${targetTag}`);

  if (
    explicitRelease &&
    integratedTag !== undefined &&
    compareVersions(explicitRelease.tag_name, integratedTag) <= 0
  ) {
    return { kind: "up-to-date", tag: integratedTag };
  }

  const pending = explicitRelease
    ? [explicitRelease]
    : stable.filter(
        (release) =>
          integratedTag === undefined || compareVersions(release.tag_name, integratedTag) > 0,
      );
  if (pending.length === 0) {
    return { kind: "up-to-date", tag: integratedTag ?? stable[0].tag_name };
  }
  const compatible = new Set(compatibleTags ?? stable.map((release) => release.tag_name));
  const release = pending.find((candidate) => compatible.has(candidate.tag_name));
  if (release) {
    const skippedTags = pending
      .filter(
        (candidate) =>
          !compatible.has(candidate.tag_name) &&
          compareVersions(candidate.tag_name, release.tag_name) > 0,
      )
      .map((candidate) => candidate.tag_name);
    return {
      ...(skippedTags.length > 0 ? { skippedTags } : {}),
      kind: "update",
      release,
    };
  }
  return {
    kind: "incompatible-upstream-history",
    tags: pending.map((candidate) => candidate.tag_name),
    upstreamCommits: upstreamCommitsPresentInMain,
    missingUpstreamCommitsByTag: Object.fromEntries(
      pending.map((candidate) => [
        candidate.tag_name,
        missingUpstreamCommitsByTag[candidate.tag_name] ?? [],
      ]),
    ),
  };
}

export function validateForkMergeProtection({ protection, repository, rulesets = [] }) {
  if (!protection || !repository) {
    throw new Error("Main branch merge protection could not be verified; refusing to merge.");
  }
  if (!Array.isArray(rulesets)) {
    throw new Error("Repository rulesets could not be verified; refusing to merge.");
  }
  if (!rulesets.every(isVerifiedRuleset)) {
    throw new Error("Repository ruleset bypass configuration is incomplete; refusing to merge.");
  }
  if (rulesets.some((ruleset) => !ruleset.bypass_actors.every(isAdminRulesetBypassActor))) {
    throw new Error(
      "Repository ruleset bypass actors must be repository admins or organization admins; the sync GitHub App must not be an admin or bypass actor.",
    );
  }
  const checks = protection.required_status_checks;
  if (checks?.strict !== true) {
    throw new Error("Main must require up-to-date status checks before the sync PR can merge.");
  }
  if (!Array.isArray(checks.checks)) {
    throw new Error("Main required status checks are incomplete; refusing to merge.");
  }
  const contexts = new Map();
  for (const check of checks.checks) {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      throw new Error("Main required status checks are incomplete; refusing to merge.");
    }
    const { context, app_id } = check;
    if (!REQUIRED_FORK_CHECKS.includes(context)) continue;
    if (contexts.has(context))
      throw new Error("Main has duplicate required status context " + context + ".");
    contexts.set(context, app_id);
  }
  const missing = REQUIRED_FORK_CHECKS.filter((name) => contexts.get(name) !== 15368);
  if (missing.length > 0) {
    throw new Error(
      "Main must require these four checks from the GitHub Actions app (15368): " +
        missing.join(", ") +
        ".",
    );
  }
  if (
    (protection.required_pull_request_reviews?.required_approving_review_count ?? 0) > 0 ||
    protection.required_pull_request_reviews?.require_code_owner_reviews === true
  ) {
    throw new Error(
      "Main cannot require additional pull request approvals for automatic sync merge.",
    );
  }
  if (
    repository.allow_merge_commit !== true ||
    protection.required_linear_history?.enabled === true
  ) {
    throw new Error(
      "Main must allow merge commits so the upstream release remains in fork history.",
    );
  }
}

function isVerifiedRuleset(ruleset) {
  return (
    ruleset !== null &&
    typeof ruleset === "object" &&
    !Array.isArray(ruleset) &&
    typeof ruleset.name === "string" &&
    Array.isArray(ruleset.bypass_actors)
  );
}

function isAdminRulesetBypassActor(actor) {
  if (actor === null || typeof actor !== "object" || Array.isArray(actor)) return false;
  const keys = Object.keys(actor);
  if (keys.some((key) => !["actor_id", "actor_type", "bypass_mode"].includes(key))) return false;
  if (!RULESET_BYPASS_MODES.has(actor.bypass_mode)) return false;

  if (actor.actor_type === "RepositoryRole") {
    return actor.actor_id === REPOSITORY_ADMIN_ROLE_ID;
  }
  if (actor.actor_type === "OrganizationAdmin") {
    return actor.actor_id === undefined || actor.actor_id === null || actor.actor_id === 1;
  }
  return false;
}

export function classifyGitHubFailure(stderr, operation) {
  const label = GITHUB_OPERATION_LABELS.get(operation) ?? "GitHub API request";
  const message = String(stderr ?? "");
  const status = /\bHTTP(?:\/[\d.]+)?\s+(\d{3})\b/i.exec(message)?.[1];
  if (/rate limit exceeded|secondary rate limit|abuse detection/i.test(message)) {
    return `GitHub ${label} failed: API rate limit reached${status ? ` (HTTP ${status})` : ""}; retry later.`;
  }
  if (status === "404" || /\b404\b|not found/i.test(message)) {
    return `GitHub ${label} failed with HTTP 404 (not found); verify repository access and the API endpoint.`;
  }
  if (
    status === "403" ||
    /resource not accessible by integration|permission denied/i.test(message)
  ) {
    return `GitHub ${label} failed: permission denied${status ? ` (HTTP ${status})` : ""}.`;
  }
  if (status === "401" || /bad credentials|requires authentication/i.test(message)) {
    return `GitHub ${label} failed: authentication rejected${status ? ` (HTTP ${status})` : ""}.`;
  }
  if (status) return `GitHub request failed during ${label} (HTTP ${status}).`;
  return `GitHub request failed during ${label}.`;
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
  { githubOperation, cwd = process.cwd(), allowFailure = false, env } = {},
) {
  try {
    return NodeChildProcess.execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : undefined,
    }).trim();
  } catch (error) {
    if (allowFailure) return undefined;
    if (githubOperation) {
      throw new Error(classifyGitHubFailure(error.stderr, githubOperation), { cause: error });
    }
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

export function validateSyncBranch({
  branch,
  branchCommit,
  mainRef,
  targetTag,
  targetCommit,
  expectedMainParent,
  cwd = process.cwd(),
}) {
  const runGit = (args, options) => git(args, { ...options, cwd });
  const expectedMarker = `${JSON.stringify({ tag: targetTag, commit: targetCommit }, null, 2)}\n`;
  const marker = `${branchCommit}:${MARKER_PATH}`;
  let actualMarker;
  try {
    actualMarker = runGit(["show", marker]);
  } catch {
    throw new Error(`Existing update branch ${branch} is missing its upstream marker.`);
  }
  if (actualMarker !== expectedMarker.trimEnd()) {
    throw new Error(`Existing update branch ${branch} has an unexpected upstream marker.`);
  }

  const branchParents = runGit(["show", "-s", "--format=%P", branchCommit]).split(" ");
  const branchChanges = (commit) =>
    runGit(["diff", "--name-only", `${commit}^`, commit])
      .split("\n")
      .filter(Boolean);
  const parentIsSyncCommit = (commit) => {
    const parents = runGit(["show", "-s", "--format=%P", commit]).split(" ");
    return (
      (parents.length === 2 && parents[1] === targetCommit) ||
      (parents.length === 1 && branchChanges(commit).includes(MARKER_PATH))
    );
  };
  const hasVersionCommit =
    branchParents.length === 1 &&
    branchChanges(branchCommit).length > 0 &&
    !branchChanges(branchCommit).includes(MARKER_PATH) &&
    parentIsSyncCommit(branchParents[0]);
  const syncCommit = hasVersionCommit ? branchParents[0] : branchCommit;
  const syncParents = runGit(["show", "-s", "--format=%P", syncCommit]).split(" ");
  const mergesStableTag = syncParents.length === 2 && syncParents[1] === targetCommit;
  const recordsTagAlreadyInMain =
    syncParents.length === 1 && isAncestor(targetCommit, syncParents[0], cwd);
  if (!mergesStableTag && !recordsTagAlreadyInMain) {
    throw new Error(
      `Existing update branch ${branch} contains unexpected commits or does not sync the expected upstream stable tag.`,
    );
  }
  const baseCommit = syncParents[0];
  if (expectedMainParent && baseCommit !== expectedMainParent) {
    throw new Error(
      `Existing update branch ${branch} does not preserve the exact fork main parent.`,
    );
  }
  if (!isAncestor(baseCommit, mainRef, cwd)) {
    throw new Error(
      `Existing update branch ${branch} is not based on the current fork main history.`,
    );
  }
  let expectedMergeTree;
  try {
    expectedMergeTree = mergesStableTag
      ? runGit(["merge-tree", "--write-tree", baseCommit, targetCommit]).split("\n")[0].trim()
      : runGit(["rev-parse", `${baseCommit}^{tree}`]);
  } catch {
    throw new Error(`Existing update branch ${branch} contains an unresolved upstream merge.`);
  }
  const mergeChanges = runGit(["diff", "--name-only", expectedMergeTree, syncCommit])
    .split("\n")
    .filter(Boolean);
  if (mergeChanges.length !== 1 || mergeChanges[0] !== MARKER_PATH) {
    throw new Error(
      `Existing update branch ${branch} contains unexpected fork changes or merge resolutions.`,
    );
  }

  const version = targetTag.replace(/^v/, "");
  const expectedVersionChanges = [];
  for (const file of releasePackageFiles) {
    const previous = JSON.parse(runGit(["show", `${syncCommit}:${file}`]));
    const current = JSON.parse(runGit(["show", `${branchCommit}:${file}`]));
    if (current.version !== version) {
      throw new Error(
        `Existing update branch ${branch} has a release manifest with the wrong version.`,
      );
    }
    if (previous.version !== version) expectedVersionChanges.push(file);
    const previousFields = { ...previous };
    const currentFields = { ...current };
    delete previousFields.version;
    delete currentFields.version;
    if (JSON.stringify(previousFields) !== JSON.stringify(currentFields)) {
      throw new Error(
        `Existing update branch ${branch} contains unexpected release manifest changes.`,
      );
    }
  }
  const actualVersionChanges = hasVersionCommit ? branchChanges(branchCommit) : [];
  if (
    JSON.stringify(actualVersionChanges.toSorted()) !==
    JSON.stringify(expectedVersionChanges.toSorted())
  ) {
    throw new Error(
      `Existing update branch ${branch} contains unexpected commits or release manifest changes.`,
    );
  }
}

export function validateMergedSyncReleaseSource({ sourceSha, mainRef, cwd = process.cwd() }) {
  if (!/^[0-9a-f]{40}$/i.test(sourceSha ?? "")) {
    throw new Error("The integration release source must be a full fork commit SHA.");
  }
  const runGit = (args, options) => git(args, { ...options, cwd });
  if (!isAncestor(sourceSha, mainRef, cwd)) {
    throw new Error("The integration release source is not contained in fork main.");
  }
  const integrationParents = runGit(["show", "-s", "--format=%P", sourceSha]).split(" ");
  if (integrationParents.length !== 2) {
    throw new Error("The integration release source is not the sync pull request merge commit.");
  }
  const [mainParent, syncBranchCommit] = integrationParents;
  const integrationTree = runGit(["rev-parse", `${sourceSha}^{tree}`]);
  const syncBranchTree = runGit(["rev-parse", `${syncBranchCommit}^{tree}`]);
  if (integrationTree !== syncBranchTree) {
    throw new Error("The fork integration merge tree differs from the verified sync PR head.");
  }

  let marker;
  try {
    marker = JSON.parse(runGit(["show", `${sourceSha}:${MARKER_PATH}`]));
  } catch {
    throw new Error("The fork integration commit is missing its upstream stable marker.");
  }
  if (
    typeof marker?.tag !== "string" ||
    !parseStableVersion(marker.tag) ||
    typeof marker.commit !== "string" ||
    !/^[0-9a-f]{40}$/i.test(marker.commit)
  ) {
    throw new Error("The fork integration commit has an invalid upstream stable marker.");
  }
  const targetCommit = resolveTagCommit(marker.tag, cwd);
  if (targetCommit.toLowerCase() !== marker.commit.toLowerCase()) {
    throw new Error("The upstream marker base does not equal the peeled stable tag commit.");
  }
  const expectedBranch = `${BRANCH_PREFIX}${marker.tag}-${targetCommit.slice(0, 8)}`;
  validateSyncBranch({
    branch: expectedBranch,
    branchCommit: syncBranchCommit,
    mainRef: mainParent,
    targetTag: marker.tag,
    targetCommit,
    expectedMainParent: mainParent,
    cwd,
  });
  const manifest = JSON.parse(runGit(["show", `${sourceSha}:apps/server/package.json`]));
  if (manifest.version !== marker.tag.replace(/^v/, "")) {
    throw new Error("The fork integration version does not match its upstream stable marker.");
  }
  if (!isAncestor(targetCommit, sourceSha, cwd)) {
    throw new Error("The upstream stable base is not an ancestor of the fork integration commit.");
  }
  return {
    sourceSha,
    upstreamTag: marker.tag,
    upstreamBase: targetCommit,
    version: manifest.version,
  };
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

function getForkCiRuns(branch, sha) {
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
          "push",
          "--limit",
          "100",
          "--json",
          "databaseId,event,headBranch,headSha,status,conclusion",
        ],
        { githubOperation: "workflowRuns" },
      ),
    );
  } catch (error) {
    throw new Error("Could not inspect fork CI runs for " + branch + ".", { cause: error });
  }
  if (!Array.isArray(runs)) throw new Error("GitHub returned invalid workflow run data.");
  return runs.filter((candidate) => candidate.headSha?.toLowerCase() === sha.toLowerCase());
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
        `get-aix:${branch}`,
        "--title",
        `chore: sync upstream stable ${targetTag}`,
        "--body-file",
        bodyPath,
      ],
      { githubOperation: "createSyncPullRequest" },
    );
  } catch (error) {
    const stderr = String(error.cause?.stderr ?? error.message ?? "");
    if (
      /not permitted|not allowed|resource not accessible by integration|pull requests.*disabled|HTTP 403/i.test(
        stderr,
      )
    ) {
      throw new Error(
        `GitHub blocked automated pull-request creation. Configure FORK_SYNC_APP_ID and FORK_SYNC_APP_PRIVATE_KEY for an installed fork App with administration:read, contents:write, and pull_requests:write. The update branch ${branch} is preserved for retry.`,
        { cause: error },
      );
    }
    throw new Error(
      `GitHub rejected pull-request creation. The update branch ${branch} is preserved for retry.`,
      { cause: error },
    );
  }
}

function resolveTagCommit(tag, cwd = process.cwd()) {
  const ref = `refs/tags/upstream/${tag}^{commit}`;
  const commit = git(["rev-parse", "--verify", ref], { cwd, allowFailure: true });
  if (!commit) throw new Error(`Upstream release tag ${tag} could not be resolved to a commit.`);
  return commit;
}

function isAncestor(commit, ref, cwd = process.cwd()) {
  try {
    NodeChildProcess.execFileSync("git", ["merge-base", "--is-ancestor", commit, ref], {
      cwd,
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

function commitsAt(ref) {
  return git(["rev-list", ref]).split("\n").filter(Boolean);
}

export function describeSkippedStableTags({ tags, missingCommitsByTag, upstreamCommitCount }) {
  const [newest, ...others] = tags;
  if (!newest) return "No upstream stable tags were skipped.";
  const missingCommits = missingCommitsByTag[newest] ?? [];
  const firstCommits = missingCommits.slice(0, 5).map((commit) => commit.slice(0, 12));
  const otherTags =
    others.length > 0
      ? ` Other skipped tags: ${others.map((tag) => `\`${tag}\``).join(", ")}.`
      : "";
  return `Skipped newest upstream stable candidate \`${newest}\`: its history omits ${missingCommits.length} of the ${upstreamCommitCount} upstream commits already in fork main${firstCommits.length > 0 ? ` (${firstCommits.join(", ")}${missingCommits.length > firstCommits.length ? ", …" : ""})` : ""}.${otherTags} Waiting for a stable tag that contains all upstream commits already in main.`;
}

function stableTagMissingCommits(tag, upstreamCommitsPresentInMain) {
  return findUpstreamCommitsMissingFromStableTag({
    upstreamCommitsPresentInMain,
    stableTagCommits: commitsAt(resolveTagCommit(tag)),
  });
}

function getPublishedReleases() {
  const output = run(
    "gh",
    [
      "api",
      "--paginate",
      "--jq",
      "map({tag_name, name, draft, prerelease})",
      `repos/${UPSTREAM_REPOSITORY}/releases?per_page=100`,
    ],
    { githubOperation: "upstreamReleases" },
  );
  let pages;
  try {
    pages = output.split("\n").map((page) => JSON.parse(page));
  } catch {
    throw new Error("GitHub returned invalid JSON for the upstream releases API.");
  }
  if (!pages.every(Array.isArray))
    throw new Error("GitHub returned an unexpected upstream releases response.");
  const releases = pages.flat(Infinity);
  if (
    !releases.every(
      (release) =>
        release &&
        typeof release === "object" &&
        !Array.isArray(release) &&
        typeof release.tag_name === "string" &&
        (release.name === null || typeof release.name === "string") &&
        typeof release.draft === "boolean" &&
        typeof release.prerelease === "boolean",
    )
  ) {
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
      "number,headRefName,headRefOid,headRepository,baseRefName,baseRefOid,isDraft,title,url",
      "--limit",
      "1000",
    ],
    { githubOperation: "openSyncPullRequests" },
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

function getWorkflowRun(runId) {
  try {
    return JSON.parse(
      run("gh", ["api", `repos/${FORK_REPOSITORY}/actions/runs/${runId}`], {
        githubOperation: "workflowRuns",
      }),
    );
  } catch (error) {
    throw new Error("Could not inspect the completed fork CI run.", { cause: error });
  }
}

function getWorkflowRunJobs(runId, attempt) {
  let pages;
  try {
    const output = run(
      "gh",
      [
        "api",
        "--paginate",
        "--jq",
        ".jobs | map({name, conclusion})",
        `repos/${FORK_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
      ],
      { githubOperation: "workflowRuns" },
    );
    pages = output.split("\n").map((page) => JSON.parse(page));
  } catch (error) {
    throw new Error("Could not inspect fork CI job results.", { cause: error });
  }
  if (!pages.every(Array.isArray)) throw new Error("GitHub returned invalid fork CI job data.");
  return pages.flat();
}

function getSyncPullRequest(branch, state = "all") {
  const output = run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      FORK_REPOSITORY,
      "--state",
      state,
      "--base",
      "main",
      "--json",
      "number,headRefName,headRefOid,headRepository,baseRefName,baseRefOid,isDraft,mergedAt,state,title,url",
      "--limit",
      "1000",
    ],
    { githubOperation: "openSyncPullRequests" },
  );
  let pullRequests;
  try {
    pullRequests = JSON.parse(output);
    if (!Array.isArray(pullRequests)) throw new Error("not an array");
  } catch {
    throw new Error("GitHub returned invalid JSON while checking for a sync pull request.");
  }
  const matches = getSyncPullRequests(pullRequests).filter(
    (pullRequest) => pullRequest.headRefName === branch,
  );
  if (matches.length > 1) throw new Error("Multiple sync pull requests use branch " + branch + ".");
  return matches[0];
}

function runProtectionGitHub(args, githubOperation) {
  const token = process.env.PROTECTION_GH_TOKEN;
  if (!token) {
    throw new Error(
      "The sync App token is required to read main protection and repository rulesets.",
    );
  }
  return run("gh", args, { githubOperation, env: { GH_TOKEN: token } });
}

function runWithSyncApp(command, args, options = {}) {
  const token = process.env.SYNC_APP_TOKEN;
  if (!token) {
    throw new Error(
      "The sync GitHub App token is required for protected merges and release dispatches.",
    );
  }
  return run(command, args, {
    ...options,
    env: { ...options.env, GH_TOKEN: token },
  });
}

function getMainProtection() {
  let protection;
  let repository;
  let rulesets;
  try {
    protection = JSON.parse(
      runProtectionGitHub(
        ["api", `repos/${FORK_REPOSITORY}/branches/main/protection`],
        "branchProtection",
      ),
    );
    repository = JSON.parse(
      runProtectionGitHub(
        ["api", `repos/${FORK_REPOSITORY}`, "--jq", "{allow_merge_commit}"],
        "repositorySettings",
      ),
    );
    rulesets = runProtectionGitHub(
      [
        "api",
        "--paginate",
        "--jq",
        ".[] | {name, bypass_actors}",
        `repos/${FORK_REPOSITORY}/rulesets?includes_parents=true&per_page=100`,
      ],
      "repositoryRulesets",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(
      "Automatic merge is blocked until main protection, repository rulesets, and merge settings can be verified.",
      { cause: error },
    );
  }
  try {
    validateForkMergeProtection({ protection, repository, rulesets });
  } catch (error) {
    throw new Error(
      "Automatic sync is blocked until main has strict required checks from GitHub Actions app 15368, allows merge commits, and limits ruleset bypasses to admins. The sync GitHub App must not be a repository admin or a ruleset bypass actor.",
      { cause: error },
    );
  }
}

export function queueForkRelease({
  version,
  sourceSha,
  sourceBranch,
  runCommand = run,
  publish = process.env.FORK_AUTO_PUBLISH_STABLE_RELEASES === "true",
}) {
  if (!parseStableVersion(version) || !/^[0-9a-f]{40}$/i.test(sourceSha ?? "")) {
    throw new Error(
      "Fork release dispatch requires a stable version and full integration commit SHA.",
    );
  }
  if (sourceBranch !== "main") {
    throw new Error("Fork releases must be queued from the integration commit on main.");
  }
  const mode = publish ? "publish" : "build-only";
  const displayTitle = `Fork ${mode} stable ${version} source ${sourceSha}`;
  let runs;
  try {
    runs = JSON.parse(
      runCommand(
        "gh",
        [
          "run",
          "list",
          "--repo",
          FORK_REPOSITORY,
          "--workflow",
          "release.yml",
          "--branch",
          "main",
          "--event",
          "workflow_dispatch",
          "--limit",
          "100",
          "--json",
          "displayTitle,status,conclusion",
        ],
        { githubOperation: "workflowRuns" },
      ),
    );
  } catch (error) {
    throw new Error("Could not check for an existing release workflow run.", { cause: error });
  }
  if (!Array.isArray(runs)) throw new Error("GitHub returned invalid release workflow data.");
  const previous = runs.find((candidate) => candidate.displayTitle === displayTitle);
  if (previous && (previous.status !== "completed" || previous.conclusion === "success")) {
    return false;
  }
  try {
    runCommand(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `repos/${FORK_REPOSITORY}/actions/workflows/release.yml/dispatches`,
        "-f",
        "ref=main",
        "-f",
        "inputs[channel]=stable",
        "-f",
        `inputs[version]=${version}`,
        "-F",
        `inputs[publish]=${publish}`,
        "-f",
        `inputs[source_commit]=${sourceSha}`,
        "-f",
        `inputs[source_branch]=${sourceBranch}`,
      ],
      { githubOperation: "workflowDispatch" },
    );
  } catch (error) {
    throw new Error("Could not queue the fork release workflow for " + version + ".", {
      cause: error,
    });
  }
  return true;
}

async function mergeSyncPullRequestFromCi() {
  const eventRunId = process.env.WORKFLOW_RUN_ID;
  const eventBranch = process.env.WORKFLOW_RUN_BRANCH;
  if (!eventRunId || !eventBranch?.startsWith(BRANCH_PREFIX)) return;

  const eventAttempt = Number(process.env.WORKFLOW_RUN_ATTEMPT);
  const eventRun = getWorkflowRun(eventRunId);
  validateForkCiCompletion({
    run: eventRun,
    eventConclusion: process.env.WORKFLOW_RUN_CONCLUSION,
    eventRunId,
    eventAttempt,
    expectedBranch: eventBranch,
    expectedSha: process.env.WORKFLOW_RUN_SHA,
  });

  const pullRequest = getSyncPullRequest(eventBranch);
  if (!pullRequest) {
    console.log("No open sync pull request matches completed fork CI; no merge action taken.");
    return;
  }
  if (
    pullRequest.headRepository?.nameWithOwner?.toLowerCase() !== FORK_REPOSITORY.toLowerCase() ||
    pullRequest.baseRefName !== "main" ||
    (pullRequest.state === "OPEN" && pullRequest.isDraft)
  ) {
    throw new Error("The sync pull request is not a PR from the fork into main.");
  }
  if (pullRequest.state === "CLOSED" && !pullRequest.mergedAt) {
    console.log("The matching sync pull request is closed without a merge; no release queued.");
    return;
  }

  const { release, commitPrefix } = releaseFromBranch(eventBranch, getPublishedReleases());
  const mainRef = "refs/remotes/origin/main";
  git(["fetch", "origin", "main"]);
  git([
    "fetch",
    "--no-tags",
    UPSTREAM_URL,
    `+refs/tags/${release.tag_name}:refs/tags/upstream/${release.tag_name}`,
  ]);
  git(["fetch", "--no-tags", UPSTREAM_URL, "+refs/heads/main:refs/remotes/upstream/main"]);
  const targetCommit = resolveTagCommit(release.tag_name);
  if (!targetCommit.startsWith(commitPrefix)) {
    throw new Error("The sync branch name does not match the published upstream tag commit.");
  }
  const upstreamCommitsPresentInMain = findUpstreamCommitsAlreadyInForkMain({
    forkMainCommits: commitsAt(mainRef),
    upstreamMainCommits: commitsAt("refs/remotes/upstream/main"),
  });
  const missingUpstreamCommits = stableTagMissingCommits(
    release.tag_name,
    upstreamCommitsPresentInMain,
  );
  if (missingUpstreamCommits.length > 0) {
    const message = describeSkippedStableTags({
      tags: [release.tag_name],
      missingCommitsByTag: { [release.tag_name]: missingUpstreamCommits },
      upstreamCommitCount: upstreamCommitsPresentInMain.length,
    });
    console.log(message);
    await writeStepSummary(message);
    return;
  }

  let branchCommit;
  if (pullRequest.state === "OPEN") {
    branchCommit = getRemoteBranchCommit(eventBranch);
    if (!branchCommit || branchCommit !== pullRequest.headRefOid) {
      throw new Error(
        "The sync pull request head changed while its CI results were being checked.",
      );
    }
  } else {
    const merged = JSON.parse(
      run("gh", ["api", `repos/${FORK_REPOSITORY}/pulls/${pullRequest.number}`], {
        githubOperation: "syncPullRequestMerge",
      }),
    );
    if (
      merged.merged !== true ||
      !merged.merge_commit_sha ||
      merged.head?.sha !== pullRequest.headRefOid
    ) {
      throw new Error(
        "The closed sync pull request does not have a verified merge commit and head.",
      );
    }
    const mergeParents = git(["show", "-s", "--format=%P", merged.merge_commit_sha]).split(" ");
    if (mergeParents.length !== 2 || mergeParents[1] !== pullRequest.headRefOid) {
      throw new Error(
        "The sync pull request merge commit does not contain its recorded head as parent.",
      );
    }
    branchCommit = pullRequest.headRefOid;
  }
  validateSyncBranch({
    branch: eventBranch,
    branchCommit,
    mainRef,
    targetTag: release.tag_name,
    targetCommit,
  });

  const latestCiRun = selectLatestForkCiRun(getForkCiRuns(eventBranch, branchCommit), {
    expectedBranch: eventBranch,
    expectedSha: branchCommit,
  });
  if (latestCiRun.databaseId !== Number(eventRunId)) {
    throw new Error(
      "A newer exact-head CI run exists; only its completion event may trigger a merge.",
    );
  }
  if (eventRun.head_sha?.toLowerCase() !== branchCommit.toLowerCase()) {
    throw new Error("The completed CI run does not match the current sync pull request head.");
  }
  const workflowRun = getWorkflowRun(latestCiRun.databaseId);
  const jobs = getWorkflowRunJobs(latestCiRun.databaseId, eventAttempt);
  validateForkCiRun({
    run: workflowRun,
    jobs,
    expectedBranch: eventBranch,
    expectedSha: branchCommit,
  });

  getMainProtection();

  if (pullRequest.state === "OPEN") {
    const currentMainSha = git(["rev-parse", mainRef]);
    if (pullRequest.baseRefOid !== currentMainSha) {
      throw new Error("The sync pull request is behind main; update and rerun CI before merging.");
    }
    let merged = false;
    try {
      const result = JSON.parse(
        runWithSyncApp(
          "gh",
          [
            "api",
            "--method",
            "PUT",
            `repos/${FORK_REPOSITORY}/pulls/${pullRequest.number}/merge`,
            "-f",
            `sha=${branchCommit}`,
            "-f",
            "merge_method=merge",
          ],
          { githubOperation: "syncPullRequestMerge" },
        ),
      );
      merged = result.merged === true;
    } catch (error) {
      const updated = runWithSyncApp(
        "gh",
        ["api", `repos/${FORK_REPOSITORY}/pulls/${pullRequest.number}`],
        { githubOperation: "syncPullRequestMerge" },
      );
      const current = JSON.parse(updated);
      if (!current.merged || current.head?.sha !== branchCommit) throw error;
      merged = true;
    }
    if (!merged) throw new Error("GitHub did not confirm the sync pull request merge.");
  } else if (pullRequest.state !== "CLOSED" || !pullRequest.mergedAt) {
    throw new Error("The sync pull request is not in a verified merged state.");
  }

  const message = `Merged upstream stable ${release.tag_name} after all four checks succeeded on exact PR head ${branchCommit}. Release dispatch waits for all four checks on the resulting integration commit on main.`;
  console.log(message);
  await writeStepSummary(message);
}

async function queueReleaseFromMainCi() {
  const eventRunId = process.env.WORKFLOW_RUN_ID;
  const sourceSha = process.env.WORKFLOW_RUN_SHA;
  if (!eventRunId || !sourceSha) return;
  const eventAttempt = Number(process.env.WORKFLOW_RUN_ATTEMPT);
  const eventRun = getWorkflowRun(eventRunId);
  validateForkCiCompletion({
    run: eventRun,
    eventConclusion: process.env.WORKFLOW_RUN_CONCLUSION,
    eventRunId,
    eventAttempt,
    expectedBranch: "main",
    expectedSha: sourceSha,
  });
  const latestCiRun = selectLatestForkCiRun(getForkCiRuns("main", sourceSha), {
    expectedBranch: "main",
    expectedSha: sourceSha,
  });
  if (latestCiRun.databaseId !== Number(eventRunId)) {
    throw new Error(
      "A newer exact-head main CI run exists; only its completion event may queue a release.",
    );
  }
  const jobs = getWorkflowRunJobs(eventRunId, eventAttempt);
  validateForkCiRun({ run: eventRun, jobs, expectedBranch: "main", expectedSha: sourceSha });

  const sourceMessage = git(["show", "-s", "--format=%B", sourceSha]);
  if (!sourceMessage.includes(BRANCH_PREFIX)) {
    const summary = `Main CI passed for ${sourceSha}; it is not an upstream stable-sync integration commit, so no fork release was queued.`;
    console.log(summary);
    await writeStepSummary(summary);
    return;
  }

  const mainRef = "refs/remotes/origin/main";
  git(["fetch", "origin", "main"]);
  git(["fetch", "--no-tags", UPSTREAM_URL, "+refs/tags/*:refs/tags/upstream/*"]);
  git(["fetch", "--no-tags", UPSTREAM_URL, "+refs/heads/main:refs/remotes/upstream/main"]);
  const upstreamCommitsPresentInMain = findUpstreamCommitsAlreadyInForkMain({
    forkMainCommits: commitsAt(sourceSha),
    upstreamMainCommits: commitsAt("refs/remotes/upstream/main"),
  });
  const releaseSource = validateMergedSyncReleaseSource({ sourceSha, mainRef });
  const missingUpstreamCommits = stableTagMissingCommits(
    releaseSource.upstreamTag,
    upstreamCommitsPresentInMain,
  );
  if (missingUpstreamCommits.length > 0) {
    const message = describeSkippedStableTags({
      tags: [releaseSource.upstreamTag],
      missingCommitsByTag: { [releaseSource.upstreamTag]: missingUpstreamCommits },
      upstreamCommitCount: upstreamCommitsPresentInMain.length,
    });
    console.log(message);
    await writeStepSummary(message);
    return;
  }
  const dispatched = queueForkRelease({
    version: releaseSource.version,
    sourceSha,
    sourceBranch: "main",
    runCommand: runWithSyncApp,
  });
  const message = dispatched
    ? `All four Fork CI jobs succeeded on integration commit ${sourceSha}; queued stable ${releaseSource.upstreamTag} with upstream base ${releaseSource.upstreamBase}.`
    : `All four Fork CI jobs succeeded on integration commit ${sourceSha}; the matching stable ${releaseSource.upstreamTag} release is already queued or published.`;
  console.log(message);
  await writeStepSummary(message);
}

function requireFork() {
  if (process.env.GITHUB_REPOSITORY?.toLowerCase() !== FORK_REPOSITORY.toLowerCase()) {
    throw new Error(
      `Upstream stable sync only runs in the explicitly guarded fork ${FORK_REPOSITORY}.`,
    );
  }
  const origin = git(["remote", "get-url", "origin"]);
  if (!/github\.com[:/]get-aix\/t3code(?:\.git)?$/i.test(origin)) {
    throw new Error(`The origin remote must point to ${FORK_REPOSITORY}; refusing to push.`);
  }
}

function writeStepSummary(message) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) return NodeFSP.writeFile(summaryPath, `${message}\n`, { flag: "a" });
  return Promise.resolve();
}

function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return Promise.resolve();
  return NodeFSP.appendFile(outputPath, `${name}=${value}\n`);
}

async function main() {
  requireFork();
  if (process.env.UPSTREAM_SYNC_MODE === "merge-on-ci") {
    await mergeSyncPullRequestFromCi();
    return;
  }
  if (process.env.UPSTREAM_SYNC_MODE === "release-after-main-ci") {
    await queueReleaseFromMainCi();
    return;
  }
  const dryRun = process.env.DRY_RUN === "true";
  const preflight = process.env.PREFLIGHT === "true";
  const releases = getPublishedReleases();
  const stableReleases = releases.filter(isStableRelease);
  if (stableReleases.length === 0) {
    if (process.env.TARGET_TAG) {
      throw new Error(
        "Target tag is not a published stable SemVer release: " + process.env.TARGET_TAG,
      );
    }
    const message = "No published stable upstream release was found; nothing to sync.";
    console.log(message);
    await writeOutput("requires_write", "false");
    await writeStepSummary(message);
    return;
  }

  const openSyncPullRequests = getOpenSyncPullRequests();
  const mainRef = "refs/remotes/origin/main";
  git(["fetch", "origin", "main"]);
  git(["fetch", "--no-tags", UPSTREAM_URL, "+refs/tags/*:refs/tags/upstream/*"]);
  git(["fetch", "--no-tags", UPSTREAM_URL, "+refs/heads/main:refs/remotes/upstream/main"]);
  const upstreamCommitsPresentInMain = findUpstreamCommitsAlreadyInForkMain({
    forkMainCommits: commitsAt(mainRef),
    upstreamMainCommits: commitsAt("refs/remotes/upstream/main"),
  });

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
    const missingUpstreamCommits = stableTagMissingCommits(
      release.tag_name,
      upstreamCommitsPresentInMain,
    );
    if (missingUpstreamCommits.length > 0) {
      const message = describeSkippedStableTags({
        tags: [release.tag_name],
        missingCommitsByTag: { [release.tag_name]: missingUpstreamCommits },
        upstreamCommitCount: upstreamCommitsPresentInMain.length,
      });
      console.log(message);
      await writeOutput("requires_write", "false");
      await writeStepSummary(message);
      return;
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
      await writeOutput("requires_write", "false");
      await writeStepSummary(message);
      return;
    }
    const message = `Existing sync pull request ${branch} verified; merge automation waits for successful push checks on its exact head.`;
    await writeOutput("requires_write", "false");
    console.log(message);
    await writeStepSummary(message);
    return;
  }

  const marker = readIntegratedMarker(mainRef, stableReleases);
  const integratedTag = marker?.tag;
  const candidateReleases = stableReleases.filter((release) => {
    if (process.env.TARGET_TAG) return release.tag_name === process.env.TARGET_TAG;
    return integratedTag === undefined || compareVersions(release.tag_name, integratedTag) > 0;
  });
  const missingUpstreamCommitsByTag = Object.fromEntries(
    candidateReleases.map((release) => [
      release.tag_name,
      stableTagMissingCommits(release.tag_name, upstreamCommitsPresentInMain),
    ]),
  );
  const compatibleTags = candidateReleases
    .filter((release) => missingUpstreamCommitsByTag[release.tag_name].length === 0)
    .map((release) => release.tag_name);
  const decision = getSyncDecision(releases, {
    integratedTag,
    targetTag: process.env.TARGET_TAG || undefined,
    compatibleTags,
    upstreamCommitsPresentInMain,
    missingUpstreamCommitsByTag,
  });

  if (decision.kind === "duplicate") {
    const message = `Skipped: an upstream stable-sync pull request is already open from \`${decision.branch}\`.`;
    console.log(message);
    await writeOutput("requires_write", "false");
    await writeStepSummary(message);
    return;
  }
  if (decision.kind === "up-to-date") {
    const message = `Up to date through upstream stable tag \`${decision.tag}\`; no pull request created.`;
    console.log(message);
    await writeOutput("requires_write", "false");
    await writeStepSummary(message);
    return;
  }

  if (decision.kind === "incompatible-upstream-history") {
    const message = describeSkippedStableTags({
      tags: decision.tags,
      missingCommitsByTag: decision.missingUpstreamCommitsByTag,
      upstreamCommitCount: decision.upstreamCommits.length,
    });
    console.log(message);
    await writeOutput("requires_write", "false");
    await writeStepSummary(message);
    return;
  }

  const skippedTagSummary = decision.skippedTags?.length
    ? describeSkippedStableTags({
        tags: decision.skippedTags,
        missingCommitsByTag: missingUpstreamCommitsByTag,
        upstreamCommitCount: upstreamCommitsPresentInMain.length,
      })
    : "";

  const targetTag = decision.release.tag_name;
  const targetCommit = resolveTagCommit(targetTag);
  if (git(["cat-file", "-t", `${targetCommit}:${MARKER_PATH}`], { allowFailure: true })) {
    throw new Error(
      `Upstream already uses ${MARKER_PATH}; refusing to overwrite it with fork sync state.`,
    );
  }
  const baseCommit = marker?.commit ?? git(["merge-base", mainRef, targetCommit]);
  const branch = `${BRANCH_PREFIX}${targetTag}-${targetCommit.slice(0, 8)}`;

  if (preflight) {
    if (dryRun) {
      const message = `${skippedTagSummary ? `${skippedTagSummary}\n\n` : ""}Dry run only; upstream stable ${targetTag} needs a sync pull request.`;
      console.log(message);
      await writeOutput("requires_write", "false");
      await writeOutput("target_tag", targetTag);
      await writeOutput("target_commit", targetCommit);
      await writeOutput("branch", branch);
      await writeStepSummary(message);
      return;
    }
    const message = `${skippedTagSummary ? `${skippedTagSummary}\n\n` : ""}Stable upstream release ${targetTag} needs a sync pull request.`;
    console.log(message);
    await writeOutput("requires_write", "true");
    await writeOutput("target_tag", targetTag);
    await writeOutput("target_commit", targetCommit);
    await writeOutput("branch", branch);
    await writeStepSummary(message);
    return;
  }

  if (!dryRun) getMainProtection();

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
    if (isAncestor(targetCommit, mainRef)) {
      git(["switch", "--create", branch, mainRef]);
    } else {
      mergeStableRelease({
        targetTag,
        mainRef,
        branch,
        tagRef: `refs/tags/upstream/${targetTag}`,
      });
    }

    await NodeFSP.writeFile(
      MARKER_PATH,
      `${JSON.stringify({ tag: targetTag, commit: targetCommit }, null, 2)}\n`,
    );
    git(["add", "--", MARKER_PATH]);
    git(["commit", "--no-verify", "--no-edit", "-m", `chore: sync upstream stable ${targetTag}`]);

    const version = targetTag.replace(/^v/, "");
    const updater = NodeURL.fileURLToPath(
      new URL("./update-release-package-versions.ts", import.meta.url),
    );
    run(process.execPath, [updater, version, "--root", process.cwd()]);
    const versionChanges = git(["diff", "--name-only"]).split("\n").filter(Boolean);
    if (versionChanges.some((file) => !releasePackageFiles.includes(file))) {
      throw new Error(
        "Release version update changed files outside the release package manifests.",
      );
    }
    if (versionChanges.length > 0) {
      git(["add", "--", ...versionChanges]);
      git(["commit", "--no-verify", "-m", `chore: set release package versions to ${version}`]);
    }
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
    `This pull request synchronizes upstream stable release **${targetTag}** (${targetCommit}).`,
    "",
    "The update branch is based on fork `main` and uses only this upstream stable tag; it never merges upstream `main`. If the tag commit is not already in fork `main`, the branch merges that tag while preserving fork commits. If the tag is already present, the branch records only the stable marker. The branch is pushed first so eligible push checks run on its exact head SHA. Automatic merge requires all four fork checks and strict protected-main rules; it never uses an administrator bypass.",
    "",
    ...(skippedTagSummary ? [skippedTagSummary, ""] : []),
    "### Upstream change summary",
    changeSummary,
    "",
    "### Verification",
    "- The GitHub App token pushes the branch and opens this PR so CI runs on its exact head without workflow approval. Merge automation waits for all four checks to succeed on that exact SHA.",
  ].join("\n");
  if (dryRun) {
    const summary = `## Upstream stable sync: ${targetTag}\n\n${skippedTagSummary ? `${skippedTagSummary}\n\n` : ""}${changeSummary}\n\nDry run only; no branch was pushed and no pull request was created.`;
    console.log(summary);
    await writeStepSummary(summary);
    return;
  }
  const bodyPath = `${process.env.RUNNER_TEMP ?? "/tmp"}/upstream-stable-sync-pr.md`;
  await NodeFSP.writeFile(bodyPath, `${body}\n`);
  if (!existingBranchCommit) git(["push", "origin", `HEAD:refs/heads/${branch}`]);
  const pullRequestUrl = createSyncPullRequest(branch, targetTag, bodyPath);
  const summary = `## Upstream stable sync: ${targetTag}\n\n${skippedTagSummary ? `${skippedTagSummary}\n\n` : ""}${changeSummary}\n\nCreated the sync pull request: ${pullRequestUrl}\n\nFork CI was triggered by the push of ${branch}. The CI completion workflow verifies all four checks against the exact head before protected merging.`;
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
