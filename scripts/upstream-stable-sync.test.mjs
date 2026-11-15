import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import ForkCiChecks from "../.github/scripts/fork-ci-checks.cjs";

import {
  classifyGitHubFailure,
  getSyncDecision,
  isStableRelease,
  mergeStableRelease,
  parseStableVersion,
  queueForkRelease,
  validateSyncBranch,
  validateForkMergeProtection,
} from "./upstream-stable-sync.mjs";

const syncScript = NodeURL.fileURLToPath(new URL("./upstream-stable-sync.mjs", import.meta.url));
const { REQUIRED_FORK_CHECKS } = ForkCiChecks;

async function createSyncFixture({
  releases = ["v0.1.9", "v0.1.10"],
  releaseApiPages,
  prCreateError,
  releaseApiError,
  pullRequestApiError,
  dispatchError,
  dryRun = false,
} = {}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t17-sync-boundary-"));
  const upstream = NodePath.join(root, "upstream.git");
  const fork = NodePath.join(root, "fork.git");
  const checkout = NodePath.join(root, "checkout");
  const bin = NodePath.join(root, "bin");
  const statePath = NodePath.join(root, "gh-state.json");
  const callsPath = NodePath.join(root, "gh-calls.jsonl");
  const git = (cwd, args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" },
    }).trim();
  const upstreamWork = NodePath.join(root, "upstream-work");
  await NodeFSP.mkdir(upstreamWork);
  git(upstreamWork, ["init", "--initial-branch=main"]);
  git(upstreamWork, ["config", "user.name", "T17 fixture"]);
  git(upstreamWork, ["config", "user.email", "t17-fixture@example.invalid"]);
  git(upstreamWork, ["config", "commit.gpgsign", "false"]);
  git(upstreamWork, ["config", "tag.gpgSign", "false"]);
  git(upstreamWork, ["config", "tag.forceSignAnnotated", "false"]);
  git(upstreamWork, ["config", "core.editor", "true"]);
  await NodeFSP.writeFile(NodePath.join(upstreamWork, "README.md"), "upstream base\n");
  git(upstreamWork, ["add", "README.md"]);
  git(upstreamWork, ["commit", "-m", "upstream 0.1.9"]);
  git(upstreamWork, ["tag", "v0.1.9"]);
  for (const [index, tag] of releases.entries()) {
    if (tag === "v0.1.9") continue;
    await NodeFSP.writeFile(NodePath.join(upstreamWork, `upstream-${index}.txt`), `${tag}\n`);
    git(upstreamWork, ["add", "."]);
    git(upstreamWork, ["commit", "-m", `upstream ${tag}`]);
    git(upstreamWork, ["tag", tag]);
  }
  git(root, ["init", "--bare", upstream]);
  git(upstreamWork, ["remote", "add", "origin", upstream]);
  git(upstreamWork, ["push", "--all", "origin"]);
  git(upstreamWork, ["push", "--tags", "origin"]);

  const forkWork = NodePath.join(root, "fork-work");
  git(root, ["clone", "--branch", "v0.1.9", upstream, forkWork]);
  git(forkWork, ["switch", "-c", "main"]);
  git(forkWork, ["config", "user.name", "T17 fixture"]);
  git(forkWork, ["config", "user.email", "t17-fixture@example.invalid"]);
  await NodeFSP.mkdir(NodePath.join(forkWork, ".github"));
  await NodeFSP.writeFile(NodePath.join(forkWork, ".github", "fixture.yml"), "name: fixture\n");
  await NodeFSP.writeFile(NodePath.join(forkWork, "fork.txt"), "fork change\n");
  git(forkWork, ["add", "."]);
  git(forkWork, ["commit", "-m", "fork change"]);
  git(root, ["clone", "--bare", forkWork, fork]);
  git(root, ["clone", "--branch", "main", fork, checkout]);
  git(checkout, ["config", "user.name", "T17 fixture"]);
  git(checkout, ["config", "user.email", "t17-fixture@example.invalid"]);
  git(checkout, ["config", "commit.gpgsign", "false"]);
  git(checkout, ["remote", "set-url", "origin", "https://github.com/Nitestack/t3code.git"]);
  git(checkout, ["config", `url.${fork}.insteadOf`, "https://github.com/Nitestack/t3code.git"]);
  git(checkout, ["config", `url.${upstream}.insteadOf`, "https://github.com/pingdotgg/t3code.git"]);

  await NodeFSP.mkdir(bin);
  const realGit = NodeChildProcess.execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const fakeGit = `#!/usr/bin/env node
import * as childProcess from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
  process.stdout.write("https://github.com/Nitestack/t3code.git\\n");
} else {
  childProcess.execFileSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
}
`;
  await NodeFSP.writeFile(NodePath.join(bin, "git"), fakeGit, { mode: 0o755 });
  const fakeGh = `#!/usr/bin/env node
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
const statePath = process.env.T17_GH_STATE;
const callsPath = process.env.T17_GH_CALLS;
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(callsPath, JSON.stringify(args) + "\\n");
const output = (value) => process.stdout.write(JSON.stringify(value));
const fail = (message) => { process.stderr.write(message + "\\n"); process.exit(1); };
const requireProtectionAppToken = (path) => {
  if (process.env.GH_TOKEN !== "fixture-sync-app-token") {
    fail("main protection reads require the sync App administration:read token");
  }
  state.protectionApiCalls ??= [];
  state.protectionApiCalls.push(path);
  fs.writeFileSync(statePath, JSON.stringify(state));
};
if (args[0] === "api" && args.some((arg) => arg.includes("/releases?"))) {
  if (state.releaseApiError) fail(state.releaseApiError);
  const projectionIndex = args.indexOf("--jq");
  const projection = projectionIndex < 0 ? undefined : args[projectionIndex + 1];
  if (projection) {
    if (projection !== "map({tag_name, name, draft, prerelease})") {
      fail("unexpected releases projection");
    }
    const projectedPages = state.releasePages.map((page) =>
      page.map((release) => ({
        tag_name: release?.tag_name ?? null,
        name: release?.name ?? null,
        draft: release?.draft ?? null,
        prerelease: release?.prerelease ?? null,
      })),
    );
    const response = projectedPages.map((page) => JSON.stringify(page)).join("\\n") + "\\n";
    state.releaseProjection = {
      pages: projectedPages,
      outputBytes: Buffer.byteLength(response),
    };
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(response);
  } else {
    output(state.releasePages);
  }
} else if (args[0] === "api" && args[1] === "repos/Nitestack/t3code/branches/main/protection") {
  requireProtectionAppToken(args[1]);
  output(state.branchProtection);
} else if (args[0] === "api" && args.some((arg) => arg.includes("/rulesets?"))) {
  requireProtectionAppToken(args.find((arg) => arg.includes("/rulesets?")));
  const rulesets = state.rulesets ?? [];
  process.stdout.write(rulesets.map((ruleset) => JSON.stringify(ruleset)).join("\\n") + (rulesets.length ? "\\n" : ""));
} else if (args[0] === "api" && args[1] === "repos/Nitestack/t3code") {
  requireProtectionAppToken(args[1]);
  output(state.repositorySettings);
} else if (args[0] === "api" && args[1] === "repos/Nitestack/t3code/actions/runs/" + state.ciRunId) {
  output(state.workflowRun);
} else if (args[0] === "api" && args.some((arg) => arg.includes("/actions/runs/" + state.ciRunId + "/attempts/"))) {
  const pages = state.workflowJobPages ?? [state.workflowJobs ?? []];
  process.stdout.write(pages.map((page) => JSON.stringify(page)).join("\\n") + "\\n");
} else if (args[0] === "api" && args.includes("--method") && args.includes("PUT")) {
  state.mergeCalls = (state.mergeCalls ?? 0) + 1;
  const pullRequest = state.pullRequests.find((candidate) => candidate.number === 17);
  if (pullRequest) {
    pullRequest.state = "CLOSED";
    pullRequest.mergedAt = "2026-11-15T12:00:00Z";
  }
  fs.writeFileSync(statePath, JSON.stringify(state));
  output({ merged: true });
} else if (args[0] === "api" && args.includes("--method") && args.includes("POST")) {
  if (state.dispatchError) fail(state.dispatchError);
  const ref = args.find((arg) => arg.startsWith("ref="))?.slice(4);
  const version = args.find((arg) => arg.startsWith("inputs[version]="))?.split("=")[1];
  const sourceSha = args.find((arg) => arg.startsWith("inputs[source_commit]="))?.split("=")[1];
  const sourceBranch = args.find((arg) => arg.startsWith("inputs[source_branch]="))?.split("=")[1];
  const publish = args.find((arg) => arg.startsWith("inputs[publish]="))?.split("=")[1] === "true";
  state.runs.push({
    databaseId: state.runs.length + 1,
    event: "workflow_dispatch",
    branch: ref,
    status: "queued",
    conclusion: null,
    displayTitle: "Fork " + (publish ? "publish" : "build-only") + " stable " + version + " source " + sourceSha,
    sourceBranch,
  });
  fs.writeFileSync(statePath, JSON.stringify(state));
} else if (args[0] === "pr" && args[1] === "list") {
  if (state.pullRequestApiError) fail(state.pullRequestApiError);
  const fields = args[args.indexOf("--json") + 1].split(",");
  const pullRequests = state.pullRequests.map((pr) => Object.fromEntries(fields.map((field) => [field, pr[field]])));
  if (state.advanceBranchOnPullRequestLookup) {
    const { worktree, branch } = state.advanceBranchOnPullRequestLookup;
    childProcess.execFileSync("git", ["-C", worktree, "push", "origin", "HEAD:refs/heads/" + branch], { stdio: "ignore" });
    delete state.advanceBranchOnPullRequestLookup;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  output(pullRequests);
} else if (args[0] === "pr" && args[1] === "create") {
  if (state.prCreateError) fail(state.prCreateError);
  const head = args[args.indexOf("--head") + 1].split(":").at(-1);
  state.pullRequests.push({ headRefName: head, headRepository: { nameWithOwner: "Nitestack/t3code" }, title: "upstream sync", url: "https://github.com/Nitestack/t3code/pull/17" });
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write("https://github.com/Nitestack/t3code/pull/17\\n");
} else if (args[0] === "run" && args[1] === "list") {
  const branch = args[args.indexOf("--branch") + 1];
  const workflow = args[args.indexOf("--workflow") + 1];
  if (workflow === "ci.yml") {
    output((state.ciRuns ?? []).filter((run) => run.headBranch === branch));
  } else {
    output(state.runs.filter((run) => run.branch === branch && run.event === "workflow_dispatch"));
  }
} else {
  fail("unexpected gh invocation: " + JSON.stringify(args));
}
`;
  const ghPath = NodePath.join(bin, "gh");
  await NodeFSP.writeFile(ghPath, fakeGh, { mode: 0o755 });
  const stableReleases = releases.map((tag) => ({
    tag_name: tag,
    name: `T3 Code ${tag}`,
    draft: false,
    prerelease: false,
  }));
  const pages = releaseApiPages ?? [stableReleases.slice(0, 1), stableReleases.slice(1)];
  await NodeFSP.writeFile(
    statePath,
    JSON.stringify({
      releasePages: pages,
      pullRequests: [],
      runs: [],
      ciRuns: [],
      protectionApiCalls: [],
      mergeCalls: 0,
      branchProtection: {
        required_status_checks: {
          strict: true,
          checks: [
            { context: "Fork Server", app_id: 15368 },
            { context: "Fork Web", app_id: 15368 },
            { context: "Fork Desktop Build", app_id: 15368 },
            { context: "Fork Mobile Type and Unit", app_id: 15368 },
          ],
        },
        enforce_admins: { enabled: false },
        required_linear_history: { enabled: false },
      },
      repositorySettings: { allow_merge_commit: true },
      rulesets: [],
      prCreateError,
      releaseApiError,
      pullRequestApiError,
      dispatchError,
    }),
  );
  const runSync = ({ dryRun: runDryRun = dryRun, env = {} } = {}) => {
    try {
      return {
        status: 0,
        output: NodeChildProcess.execFileSync(process.execPath, [syncScript], {
          cwd: checkout,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${NodePath.dirname(process.execPath)}:${process.env.PATH}`,
            GITHUB_REPOSITORY: "Nitestack/t3code",
            DRY_RUN: runDryRun ? "true" : "false",
            GH_TOKEN: "fixture-github-token",
            PROTECTION_GH_TOKEN: "fixture-sync-app-token",
            T17_GH_STATE: statePath,
            T17_GH_CALLS: callsPath,
            ...env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (error) {
      return { status: error.status, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  };
  const readState = async () => JSON.parse(await NodeFSP.readFile(statePath, "utf8"));
  const writeState = async (state) => NodeFSP.writeFile(statePath, JSON.stringify(state));
  const readCalls = async () => {
    const contents = await NodeFSP.readFile(callsPath, "utf8").catch(() => "");
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  return { root, fork, checkout, statePath, runSync, readState, writeState, readCalls, git };
}

async function prepareSuccessfulCiEvent(fixture) {
  const sync = fixture.runSync();
  NodeAssert.equal(sync.status, 0, sync.output);
  const state = await fixture.readState();
  const pullRequest = state.pullRequests[0];
  const branch = pullRequest.headRefName;
  const headSha = fixture.git(fixture.fork, ["rev-parse", `refs/heads/${branch}`]);
  const baseSha = fixture.git(fixture.checkout, ["rev-parse", "refs/remotes/origin/main"]);
  const runId = 79001;
  Object.assign(pullRequest, {
    number: 17,
    headRefOid: headSha,
    headRepository: { nameWithOwner: "Nitestack/t3code" },
    baseRefName: "main",
    baseRefOid: baseSha,
    isDraft: false,
    state: "OPEN",
    mergedAt: null,
  });
  state.ciRunId = runId;
  state.ciRuns = [
    {
      databaseId: runId,
      event: "push",
      headBranch: branch,
      headSha,
      status: "completed",
      conclusion: "success",
    },
  ];
  state.workflowRun = {
    id: runId,
    path: ".github/workflows/ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    head_repository: { full_name: "Nitestack/t3code" },
    head_branch: branch,
    head_sha: headSha,
  };
  state.workflowJobs = REQUIRED_FORK_CHECKS.map((name) => ({ name, conclusion: "success" }));
  await fixture.writeState(state);
  return {
    branch,
    headSha,
    env: {
      UPSTREAM_SYNC_MODE: "merge-on-ci",
      WORKFLOW_RUN_ID: String(runId),
      WORKFLOW_RUN_BRANCH: branch,
      WORKFLOW_RUN_ATTEMPT: "1",
      WORKFLOW_RUN_CONCLUSION: "success",
      WORKFLOW_RUN_SHA: headSha,
    },
  };
}

const releases = [
  { tag_name: "v4.2.0", name: "T3 Code 4.2.0", draft: false, prerelease: false },
  { tag_name: "v4.3.0-rc.1", name: "T3 Code 4.3.0 RC", draft: false, prerelease: true },
  { tag_name: "v4.3.0", name: "T3 Code 4.3.0", draft: true, prerelease: false },
  { tag_name: "v4.3.0", name: "Maintainer test build", draft: false, prerelease: false },
  { tag_name: "v4.3.0-preview.1", name: "Preview", draft: false, prerelease: false },
  { tag_name: "test-build-2026-11-13", name: "T3 Code test", draft: false, prerelease: false },
];

NodeTest.test("accepts only published stable SemVer releases without test labels", () => {
  NodeAssert.equal(isStableRelease(releases[0]), true);
  for (const release of releases.slice(1)) {
    NodeAssert.equal(isStableRelease(release), false, release.tag_name);
  }
  NodeAssert.equal(parseStableVersion("v4.2.0").join("."), "4.2.0");
  NodeAssert.equal(parseStableVersion("4.2.0-rc.1"), undefined);
  NodeAssert.equal(parseStableVersion("v04.2.0"), undefined);
});

NodeTest.test("skips the already integrated tag and selects a newer stable release", () => {
  const stableReleases = [
    releases[0],
    {
      tag_name: "v4.3.0",
      name: "T3 Code 4.3.0",
      draft: false,
      prerelease: false,
    },
  ];

  NodeAssert.deepEqual(getSyncDecision(stableReleases, { integratedTag: "v4.3.0" }), {
    kind: "up-to-date",
    tag: "v4.3.0",
  });
  NodeAssert.deepEqual(getSyncDecision(stableReleases, { integratedTag: "v4.2.0" }), {
    kind: "update",
    release: stableReleases[1],
  });
  const numericallySorted = [
    { tag_name: "v4.9.0", name: "T3 Code 4.9.0", draft: false, prerelease: false },
    { tag_name: "v4.10.0", name: "T3 Code 4.10.0", draft: false, prerelease: false },
  ];
  NodeAssert.equal(getSyncDecision(numericallySorted).release.tag_name, "v4.10.0");
});

NodeTest.test("an empty stable release list is a successful no-op", () => {
  NodeAssert.deepEqual(getSyncDecision([]), { kind: "no-releases" });
  NodeAssert.throws(
    () => getSyncDecision([], { targetTag: "v1.2.3" }),
    /Target tag is not a published stable SemVer release/,
  );
});

NodeTest.test(
  "release queueing deduplicates queued and already successful exact-source runs",
  () => {
    const sourceSha = "a".repeat(40);
    const displayTitle = `Fork build-only stable 0.1.10 source ${sourceSha}`;
    for (const previous of [
      { displayTitle, status: "queued", conclusion: null },
      { displayTitle, status: "completed", conclusion: "success" },
    ]) {
      const calls = [];
      const runCommand = (_command, args) => {
        calls.push(args);
        return args[0] === "run" ? JSON.stringify([previous]) : "";
      };
      NodeAssert.equal(
        queueForkRelease({
          version: "0.1.10",
          sourceSha,
          sourceBranch: "automation/upstream-stable-v0.1.10-c2e54e3a",
          runCommand,
          publish: false,
        }),
        false,
      );
      NodeAssert.equal(calls.length, 1);
    }

    const retryCalls = [];
    const retryRun = (_command, args) => {
      retryCalls.push(args);
      return args[0] === "run"
        ? JSON.stringify([{ displayTitle, status: "completed", conclusion: "failure" }])
        : "";
    };
    NodeAssert.equal(
      queueForkRelease({
        version: "0.1.10",
        sourceSha,
        sourceBranch: "automation/upstream-stable-v0.1.10-c2e54e3a",
        runCommand: retryRun,
        publish: false,
      }),
      true,
    );
    NodeAssert.equal(retryCalls.length, 2);
    NodeAssert.ok(retryCalls[1].includes(`inputs[source_commit]=${sourceSha}`));
    NodeAssert.ok(
      retryCalls[1].includes("inputs[source_branch]=automation/upstream-stable-v0.1.10-c2e54e3a"),
    );
  },
);

NodeTest.test("automatic merge requires strict fork checks while exempting admins", () => {
  const protection = {
    required_status_checks: {
      strict: true,
      checks: [
        { context: "Fork Server", app_id: 15368 },
        { context: "Fork Web", app_id: 15368 },
        { context: "Fork Desktop Build", app_id: 15368 },
        { context: "Fork Mobile Type and Unit", app_id: 15368 },
      ],
    },
    enforce_admins: { enabled: true },
    required_linear_history: { enabled: false },
  };
  NodeAssert.doesNotThrow(() =>
    validateForkMergeProtection({ protection, repository: { allow_merge_commit: true } }),
  );
  NodeAssert.doesNotThrow(() =>
    validateForkMergeProtection({
      protection: { ...protection, enforce_admins: { enabled: false } },
      repository: { allow_merge_commit: true },
    }),
  );
  NodeAssert.throws(
    () =>
      validateForkMergeProtection({
        protection: {
          ...protection,
          required_status_checks: { ...protection.required_status_checks, strict: false },
        },
        repository: { allow_merge_commit: true },
      }),
    /up-to-date status checks/,
  );
  NodeAssert.throws(
    () =>
      validateForkMergeProtection({
        protection: {
          ...protection,
          required_status_checks: {
            ...protection.required_status_checks,
            checks: protection.required_status_checks.checks.map((check) =>
              check.context === "Fork Web" ? { ...check, app_id: null } : check,
            ),
          },
        },
        repository: { allow_merge_commit: true },
      }),
    /GitHub Actions app \(15368\)/,
  );
  NodeAssert.throws(
    () =>
      validateForkMergeProtection({
        protection: {
          ...protection,
          required_status_checks: {
            ...protection.required_status_checks,
            checks: protection.required_status_checks.checks.slice(1),
          },
        },
        repository: { allow_merge_commit: true },
      }),
    /GitHub Actions app \(15368\)/,
  );
  NodeAssert.throws(
    () => validateForkMergeProtection({ protection, repository: { allow_merge_commit: false } }),
    /allow merge commits/,
  );
  NodeAssert.throws(
    () =>
      validateForkMergeProtection({
        protection: {
          ...protection,
          required_pull_request_reviews: { required_approving_review_count: 1 },
        },
        repository: { allow_merge_commit: true },
      }),
    /cannot require additional pull request approvals/,
  );
  for (const actor of [
    { actor_id: 45123, actor_type: "Integration", bypass_mode: "always" },
    { actor_id: 2, actor_type: "Team", bypass_mode: "always" },
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "unknown" },
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always", unknown: true },
  ]) {
    NodeAssert.throws(
      () =>
        validateForkMergeProtection({
          protection,
          repository: { allow_merge_commit: true },
          rulesets: [{ name: "main", bypass_actors: [actor] }],
        }),
      /sync GitHub App must not be an admin or bypass actor/,
    );
  }
  NodeAssert.doesNotThrow(() =>
    validateForkMergeProtection({
      protection,
      repository: { allow_merge_commit: true },
      rulesets: [
        {
          name: "main",
          bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
        },
      ],
    }),
  );
  NodeAssert.doesNotThrow(() =>
    validateForkMergeProtection({
      protection,
      repository: { allow_merge_commit: true },
      rulesets: [
        {
          name: "main",
          bypass_actors: [{ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "exempt" }],
        },
      ],
    }),
  );
  NodeAssert.throws(
    () =>
      validateForkMergeProtection({
        protection,
        repository: { allow_merge_commit: true },
        rulesets: [
          { name: "main", bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole" }] },
        ],
      }),
    /sync GitHub App must not be an admin or bypass actor/,
  );
});

NodeTest.test(
  "validates a requested target against the stable releases and avoids duplicate PRs",
  () => {
    NodeAssert.deepEqual(getSyncDecision(releases, { targetTag: "v4.2.0" }), {
      kind: "update",
      release: releases[0],
    });
    NodeAssert.throws(
      () => getSyncDecision(releases, { targetTag: "v4.3.0-rc.1" }),
      /Target tag is not a published stable SemVer release/,
    );
    NodeAssert.deepEqual(
      getSyncDecision(releases, {
        openSyncPullRequests: [
          {
            headRefName: "automation/upstream-stable-v4.2.0",
            headRepository: { nameWithOwner: "Nitestack/t3code" },
          },
        ],
      }),
      { kind: "duplicate", branch: "automation/upstream-stable-v4.2.0" },
    );
    for (const headRepository of [undefined, null, { nameWithOwner: "contributor/t3code" }]) {
      NodeAssert.equal(
        getSyncDecision(releases, {
          openSyncPullRequests: [
            { headRefName: "automation/upstream-stable-v4.2.0", headRepository },
          ],
        }).kind,
        "update",
      );
    }
  },
);

NodeTest.test("classifies GitHub failures by operation without exposing raw errors", () => {
  const sentinel = "SENTINEL_PRIVATE_GH_ERROR_TEXT";
  const releasesFailure = classifyGitHubFailure(`gh: HTTP 404: ${sentinel}`, "upstreamReleases");
  NodeAssert.match(releasesFailure, /upstream releases lookup/i);
  NodeAssert.match(releasesFailure, /404/);
  NodeAssert.doesNotMatch(releasesFailure, new RegExp(sentinel));

  const prsFailure = classifyGitHubFailure(
    `GraphQL: Resource not accessible by integration (${sentinel})`,
    "openSyncPullRequests",
  );
  NodeAssert.match(prsFailure, /open sync pull-request lookup/i);
  NodeAssert.match(prsFailure, /permission denied/i);
  NodeAssert.doesNotMatch(prsFailure, new RegExp(sentinel));

  NodeAssert.match(
    classifyGitHubFailure("API rate limit exceeded for user", "upstreamReleases"),
    /rate limit/i,
  );
  NodeAssert.match(
    classifyGitHubFailure("socket closed", "openSyncPullRequests"),
    /GitHub request failed.*open sync pull-request lookup/i,
  );
});

NodeTest.test(
  "reports whether releases or open-PR lookup failed without leaking stderr",
  async () => {
    const sentinel = "SENTINEL_PRIVATE_GH_ERROR_TEXT";
    for (const [failure, operation] of [
      [{ releaseApiError: `gh: HTTP 403: ${sentinel}` }, /upstream releases lookup.*403/],
      [
        { pullRequestApiError: `GraphQL: Resource not accessible by integration (${sentinel})` },
        /open sync pull-request lookup.*permission denied/,
      ],
    ]) {
      const fixture = await createSyncFixture(failure);
      try {
        const result = fixture.runSync();
        NodeAssert.equal(result.status, 1, result.output);
        NodeAssert.match(result.output, operation);
        NodeAssert.doesNotMatch(result.output, new RegExp(sentinel));
      } finally {
        await NodeFSP.rm(fixture.root, { recursive: true, force: true });
      }
    }
  },
);

NodeTest.test("a 0.1.9 release already in main is a true no-op", async () => {
  const fixture = await createSyncFixture({ releases: ["v0.1.9"] });
  try {
    const result = fixture.runSync();
    NodeAssert.equal(result.status, 0, result.output);
    NodeAssert.match(result.output, /Up to date through upstream stable tag `v0\.1\.9`/);
    NodeAssert.equal(
      (await fixture.readCalls()).some((args) => args.includes("--method")),
      false,
    );
  } finally {
    await NodeFSP.rm(fixture.root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "an empty upstream release list succeeds without querying or mutating the fork",
  async () => {
    const fixture = await createSyncFixture({ releaseApiPages: [[]] });
    try {
      const result = fixture.runSync();
      NodeAssert.equal(result.status, 0, result.output);
      NodeAssert.match(
        result.output,
        /No published stable upstream release was found; nothing to sync/,
      );
      const calls = await fixture.readCalls();
      NodeAssert.equal(calls.length, 1);
      NodeAssert.equal(
        calls[0].some((argument) => argument.includes("/releases?")),
        true,
      );
      NodeAssert.equal(
        calls.some((args) => args[0] === "pr" || args.includes("--method")),
        false,
      );
    } finally {
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "dry run reports the candidate without pushing or opening a pull request",
  async () => {
    for (const foreignPr of [false, true]) {
      const fixture = await createSyncFixture({ dryRun: true });
      try {
        const initialState = await fixture.readState();
        if (foreignPr) {
          initialState.pullRequests.push({
            headRefName: "automation/upstream-stable-v0.1.10-deadbeef",
            headRepository: { nameWithOwner: "contributor/t3code" },
          });
          await fixture.writeState(initialState);
        }
        const result = fixture.runSync();
        NodeAssert.equal(result.status, 0, result.output);
        NodeAssert.match(
          result.output,
          /Dry run only; no branch was pushed and no pull request was created/,
        );
        const state = await fixture.readState();
        NodeAssert.deepEqual(state.pullRequests, initialState.pullRequests);
        NodeAssert.equal(state.runs.length, 0);
        NodeAssert.equal(
          fixture.git(fixture.fork, [
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/automation",
          ]),
          "",
        );
      } finally {
        await NodeFSP.rm(fixture.root, { recursive: true, force: true });
      }
    }
  },
);

NodeTest.test(
  "reuses a pushed sync branch after PR creation fails without dispatching PR-head CI",
  async () => {
    const fixture = await createSyncFixture({
      prCreateError:
        "GitHub Actions is not permitted to create or approve pull requests with GITHUB_TOKEN",
    });
    try {
      const failed = fixture.runSync();
      NodeAssert.equal(failed.status, 1);
      NodeAssert.match(
        failed.output,
        /FORK_SYNC_APP_ID.*administration:read.*contents:write.*pull_requests:write/i,
      );
      const pushedBranch = fixture
        .git(fixture.fork, ["for-each-ref", "--format=%(refname:short)", "refs/heads/automation"])
        .split("\n")
        .find((branch) => branch.startsWith("automation/upstream-stable-"));
      NodeAssert.match(
        pushedBranch,
        /^automation\/upstream-stable-v0\.1\.10-[0-9a-f]{8}$/,
        failed.output,
      );
      const pushedRef = fixture.git(fixture.fork, ["rev-parse", `refs/heads/${pushedBranch}`]);

      const state = await fixture.readState();
      state.prCreateError = undefined;
      await fixture.writeState(state);
      const retry = fixture.runSync();
      NodeAssert.equal(retry.status, 0, retry.output);
      NodeAssert.equal(
        fixture.git(fixture.fork, ["rev-parse", `refs/heads/${pushedBranch}`]),
        pushedRef,
      );
      const finalState = await fixture.readState();
      NodeAssert.equal(finalState.pullRequests.length, 1);
      NodeAssert.equal(finalState.runs.length, 0);
    } finally {
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "an existing sync PR is idempotent and waits for event-driven exact-head CI",
  async () => {
    const fixture = await createSyncFixture();
    try {
      const initial = fixture.runSync();
      NodeAssert.equal(initial.status, 0, initial.output);
      const state = await fixture.readState();
      NodeAssert.equal(state.pullRequests.length, 1);
      state.runs = [];
      await fixture.writeState(state);

      const dryRun = fixture.runSync({ dryRun: true });
      NodeAssert.equal(dryRun.status, 0, dryRun.output);
      NodeAssert.match(dryRun.output, /Dry run only/);
      NodeAssert.equal((await fixture.readState()).runs.length, 0);

      const retry = fixture.runSync();
      NodeAssert.equal(retry.status, 0, retry.output);
      const recovered = await fixture.readState();
      NodeAssert.equal(recovered.pullRequests.length, 1);
      NodeAssert.equal(recovered.runs.length, 0);
      NodeAssert.match(retry.output, /waits for successful push checks on its exact head/);

      const third = fixture.runSync();
      NodeAssert.equal(third.status, 0, third.output);
      NodeAssert.equal((await fixture.readState()).pullRequests.length, 1);
    } finally {
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  },
);

NodeTest.test("reports a releases API error at the gh boundary", async () => {
  for (const [releaseApiError, expected] of [
    ["HTTP 404: Not Found", /upstream releases lookup failed with HTTP 404/i],
    ["HTTP 403: API rate limit exceeded for user", /rate limit/i],
  ]) {
    const fixture = await createSyncFixture({ releaseApiError });
    try {
      const result = fixture.runSync();
      NodeAssert.equal(result.status, 1);
      NodeAssert.match(result.output, expected);
    } finally {
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

NodeTest.test("projects paginated release metadata before buffering large API bodies", async () => {
  const releaseApiPages = [
    [
      {
        tag_name: "v0.1.9",
        name: "T3 Code 0.1.9",
        draft: false,
        prerelease: false,
      },
    ],
    [
      {
        tag_name: "v0.1.10",
        name: "T3 Code 0.1.10",
        draft: false,
        prerelease: false,
        body: "x".repeat(1_100_000),
        assets: [{ name: "release.zip", url: "https://example.invalid/release.zip" }],
      },
      {
        tag_name: "v0.1.11-rc.1",
        name: "T3 Code 0.1.11 RC",
        draft: false,
        prerelease: true,
      },
      {
        tag_name: "v0.1.11",
        name: "T3 Code 0.1.11",
        draft: true,
        prerelease: false,
      },
      {
        tag_name: "v0.1.11",
        name: "Maintainer test build",
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "v0.1.12-preview.1",
        name: "Preview",
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "test-build-2026-11-13",
        name: "T3 Code test",
        draft: false,
        prerelease: false,
      },
    ],
  ];
  const fixture = await createSyncFixture({
    releases: ["v0.1.9", "v0.1.10"],
    releaseApiPages,
    dryRun: true,
  });
  try {
    const rawReleaseBytes = Buffer.byteLength(JSON.stringify(releaseApiPages));
    NodeAssert.ok(rawReleaseBytes > 1_048_576);

    const result = fixture.runSync();
    NodeAssert.equal(result.status, 0, result.output);
    NodeAssert.match(result.output, /Upstream stable sync: v0\.1\.10/);
    NodeAssert.match(result.output, /Dry run only/);

    const state = await fixture.readState();
    NodeAssert.deepEqual(state.releaseProjection.pages, [
      [
        {
          tag_name: "v0.1.9",
          name: "T3 Code 0.1.9",
          draft: false,
          prerelease: false,
        },
      ],
      releaseApiPages[1].map(({ tag_name, name, draft, prerelease }) => ({
        tag_name,
        name,
        draft,
        prerelease,
      })),
    ]);
    NodeAssert.ok(state.releaseProjection.outputBytes < 1_048_576);
    const releaseCall = (await fixture.readCalls()).find((args) =>
      args.some((argument) => argument.includes("/releases?")),
    );
    NodeAssert.ok(releaseCall.includes("--paginate"));
    NodeAssert.ok(releaseCall.includes("--jq"));
    NodeAssert.equal(releaseCall.includes("--slurp"), false);
  } finally {
    await NodeFSP.rm(fixture.root, { recursive: true, force: true });
  }
});

NodeTest.test("rejects malformed projected release metadata", async () => {
  const fixture = await createSyncFixture({
    releaseApiPages: [
      [
        {
          tag_name: "v0.1.10",
          name: "T3 Code 0.1.10",
          draft: false,
          prerelease: "false",
        },
      ],
    ],
    dryRun: true,
  });
  try {
    const result = fixture.runSync();
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(result.output, /unexpected upstream release entry/);
  } finally {
    await NodeFSP.rm(fixture.root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "missing main protection blocks before pushing a branch or opening a PR",
  async () => {
    const fixture = await createSyncFixture();
    try {
      const state = await fixture.readState();
      state.branchProtection = null;
      await fixture.writeState(state);

      const result = fixture.runSync();
      NodeAssert.equal(result.status, 1, result.output);
      NodeAssert.match(result.output, /strict required checks from GitHub Actions app 15368/);
      NodeAssert.equal((await fixture.readState()).pullRequests.length, 0);
      NodeAssert.equal(
        fixture.git(fixture.fork, [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads/automation",
        ]),
        "",
      );
    } finally {
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "main protection reads use the sync App token and accept admin-only ruleset bypass",
  async () => {
    const fixture = await createSyncFixture();
    try {
      const state = await fixture.readState();
      state.branchProtection.enforce_admins = { enabled: false };
      state.rulesets = [
        {
          name: "main",
          bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
        },
      ];
      await fixture.writeState(state);

      const result = fixture.runSync();
      NodeAssert.equal(result.status, 0, result.output);
      NodeAssert.deepEqual((await fixture.readState()).protectionApiCalls, [
        "repos/Nitestack/t3code/branches/main/protection",
        "repos/Nitestack/t3code",
        "repos/Nitestack/t3code/rulesets?includes_parents=true&per_page=100",
      ]);
    } finally {
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "validateSyncBranch accepts only the marked upstream merge based on fork main",
  async () => {
    const fixture = await createSyncFixture();
    try {
      const sync = fixture.runSync();
      NodeAssert.equal(sync.status, 0, sync.output);
      const state = await fixture.readState();
      const branch = state.pullRequests[0].headRefName;
      const branchCommit = fixture.git(fixture.fork, ["rev-parse", `refs/heads/${branch}`]);
      const targetCommit = fixture.git(fixture.checkout, [
        "rev-parse",
        "refs/tags/upstream/v0.1.10^{commit}",
      ]);
      const args = {
        branch,
        branchCommit,
        mainRef: "refs/remotes/origin/main",
        targetTag: "v0.1.10",
        targetCommit,
        cwd: fixture.checkout,
      };
      NodeAssert.doesNotThrow(() => validateSyncBranch(args));
      NodeAssert.throws(
        () => validateSyncBranch({ ...args, targetCommit: "0".repeat(40) }),
        /unexpected upstream marker/,
      );
    } finally {
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "merge handler checks exact CI, merges by head SHA, and queues one release",
  async () => {
    const fixture = await createSyncFixture();
    try {
      const event = await prepareSuccessfulCiEvent(fixture);
      const result = fixture.runSync({ env: event.env });
      NodeAssert.equal(result.status, 0, result.output);
      NodeAssert.match(result.output, /queued the fork release for exact source/);
      const state = await fixture.readState();
      NodeAssert.equal(state.mergeCalls, 1);
      NodeAssert.equal(state.runs.length, 1);
      NodeAssert.equal(
        state.runs[0].displayTitle,
        `Fork build-only stable 0.1.10 source ${event.headSha}`,
      );
      const mergeCall = (await fixture.readCalls()).find(
        (args) => args.includes("--method") && args.includes("PUT"),
      );
      NodeAssert.ok(mergeCall.includes(`sha=${event.headSha}`));
    } finally {
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  },
);

NodeTest.test("merge handler rejects a PR head race after the successful CI event", async () => {
  const fixture = await createSyncFixture();
  try {
    const event = await prepareSuccessfulCiEvent(fixture);
    const branchWorktree = NodePath.join(fixture.root, "advanced-sync-branch");
    fixture.git(fixture.root, ["clone", "--branch", event.branch, fixture.fork, branchWorktree]);
    fixture.git(branchWorktree, ["config", "user.name", "T17 fixture"]);
    fixture.git(branchWorktree, ["config", "user.email", "t17-fixture@example.invalid"]);
    await NodeFSP.writeFile(NodePath.join(branchWorktree, "raced.txt"), "advanced after CI\n");
    fixture.git(branchWorktree, ["add", "raced.txt"]);
    fixture.git(branchWorktree, ["commit", "-m", "advance sync branch after CI"]);

    const state = await fixture.readState();
    state.advanceBranchOnPullRequestLookup = { worktree: branchWorktree, branch: event.branch };
    await fixture.writeState(state);
    const result = fixture.runSync({ env: event.env });
    NodeAssert.equal(result.status, 1, result.output);
    NodeAssert.match(result.output, /head changed while its CI results were being checked/);
    const finalState = await fixture.readState();
    NodeAssert.equal(finalState.mergeCalls, 0);
    NodeAssert.equal(finalState.runs.length, 0);
  } finally {
    await NodeFSP.rm(fixture.root, { recursive: true, force: true });
  }
});

NodeTest.test("stops on unexpected changes in an existing update branch", async () => {
  const fixture = await createSyncFixture();
  try {
    const initial = fixture.runSync();
    NodeAssert.equal(initial.status, 0, initial.output);
    const state = await fixture.readState();
    const branch = state.pullRequests[0].headRefName;
    const tampered = NodePath.join(fixture.root, "tampered");
    fixture.git(fixture.root, ["clone", "--branch", branch, fixture.fork, tampered]);
    fixture.git(tampered, ["config", "user.name", "T17 fixture"]);
    fixture.git(tampered, ["config", "user.email", "t17-fixture@example.invalid"]);
    await NodeFSP.writeFile(NodePath.join(tampered, "unexpected.txt"), "preserve me\n");
    fixture.git(tampered, ["add", "unexpected.txt"]);
    fixture.git(tampered, ["commit", "-m", "unexpected fork change"]);
    fixture.git(tampered, ["push", "origin", branch]);
    const unexpectedCommit = fixture.git(tampered, ["rev-parse", "HEAD"]);
    const previousCalls = (await fixture.readCalls()).length;

    const retry = fixture.runSync();
    NodeAssert.equal(retry.status, 1);
    NodeAssert.match(
      retry.output,
      /contains unexpected commits or does not merge the expected upstream tag/,
    );
    NodeAssert.equal(
      fixture.git(fixture.fork, ["rev-parse", `refs/heads/${branch}`]),
      unexpectedCommit,
    );
    const retryCalls = (await fixture.readCalls()).slice(previousCalls);
    NodeAssert.equal(
      retryCalls.some((args) => args[1] === "create"),
      false,
    );
    NodeAssert.equal(
      retryCalls.some((args) => args.includes("--method")),
      false,
    );
  } finally {
    await NodeFSP.rm(fixture.root, { recursive: true, force: true });
  }
});

NodeTest.test("fork CI explicitly runs contracts tests in addition to server tests", async () => {
  const workflow = await NodeFSP.readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const forkServer = workflow.split("\n  fork_server:")[1]?.split("\n  fork_web:")[0] ?? "";
  NodeAssert.match(forkServer, /vp run --filter @t3tools\/contracts test/);
});

NodeTest.test("a merge conflict fails on the update branch and leaves main unchanged", async () => {
  const repository = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t17-sync-"));
  const runGit = (args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  try {
    runGit(["init", "--initial-branch=main"]);
    runGit(["config", "user.name", "T17 fixture"]);
    runGit(["config", "user.email", "t17-fixture@example.invalid"]);
    runGit(["config", "commit.gpgsign", "false"]);
    runGit(["config", "tag.gpgSign", "false"]);
    await NodeFSP.writeFile(NodePath.join(repository, "shared.txt"), "base\n");
    runGit(["add", "shared.txt"]);
    runGit(["commit", "-m", "base"]);
    runGit(["switch", "-c", "upstream"]);
    await NodeFSP.writeFile(NodePath.join(repository, "shared.txt"), "upstream\n");
    runGit(["add", "shared.txt"]);
    runGit(["commit", "-m", "upstream change"]);
    runGit(["tag", "v1.2.3"]);
    runGit(["switch", "main"]);
    await NodeFSP.writeFile(NodePath.join(repository, "shared.txt"), "fork\n");
    runGit(["add", "shared.txt"]);
    runGit(["commit", "-m", "fork change"]);
    const mainCommit = runGit(["rev-parse", "refs/heads/main"]);

    NodeAssert.throws(
      () =>
        mergeStableRelease({
          targetTag: "v1.2.3",
          mainRef: "refs/heads/main",
          branch: "automation/upstream-stable-v1.2.3",
          tagRef: "refs/tags/v1.2.3",
          cwd: repository,
        }),
      /Could not merge upstream stable tag v1\.2\.3.*shared\.txt/,
    );
    NodeAssert.equal(runGit(["rev-parse", "refs/heads/main"]), mainCommit);
    NodeAssert.equal(runGit(["branch", "--show-current"]), "automation/upstream-stable-v1.2.3");
  } finally {
    await NodeFSP.rm(repository, { recursive: true, force: true });
  }
});

NodeTest.test("a non-conflicting stable merge retains fork files", async () => {
  const repository = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t17-sync-"));
  const runGit = (args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  try {
    runGit(["init", "--initial-branch=main"]);
    runGit(["config", "user.name", "T17 fixture"]);
    runGit(["config", "user.email", "t17-fixture@example.invalid"]);
    runGit(["config", "commit.gpgsign", "false"]);
    runGit(["config", "tag.gpgSign", "false"]);
    await NodeFSP.writeFile(NodePath.join(repository, "shared.txt"), "base\n");
    runGit(["add", "shared.txt"]);
    runGit(["commit", "-m", "base"]);
    runGit(["switch", "-c", "upstream"]);
    await NodeFSP.writeFile(NodePath.join(repository, "upstream.txt"), "upstream\n");
    runGit(["add", "upstream.txt"]);
    runGit(["commit", "-m", "upstream change"]);
    runGit(["tag", "v1.2.3"]);
    runGit(["switch", "main"]);
    await NodeFSP.writeFile(NodePath.join(repository, "fork.txt"), "fork\n");
    runGit(["add", "fork.txt"]);
    runGit(["commit", "-m", "fork change"]);
    const mainCommit = runGit(["rev-parse", "refs/heads/main"]);

    mergeStableRelease({
      targetTag: "v1.2.3",
      mainRef: "refs/heads/main",
      branch: "automation/upstream-stable-v1.2.3",
      tagRef: "refs/tags/v1.2.3",
      cwd: repository,
    });
    NodeAssert.equal(runGit(["rev-parse", "refs/heads/main"]), mainCommit);
    NodeAssert.equal(runGit(["branch", "--show-current"]), "automation/upstream-stable-v1.2.3");
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(repository, "fork.txt"), "utf8"),
      "fork\n",
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(repository, "upstream.txt"), "utf8"),
      "upstream\n",
    );
  } finally {
    await NodeFSP.rm(repository, { recursive: true, force: true });
  }
});
