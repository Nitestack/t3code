import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  classifyGitHubFailure,
  getSyncDecision,
  isStableRelease,
  mergeStableRelease,
  parseStableVersion,
} from "./upstream-stable-sync.mjs";

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
        openSyncPullRequests: [{ headRefName: "automation/upstream-stable-v4.2.0" }],
      }),
      { kind: "duplicate", branch: "automation/upstream-stable-v4.2.0" },
    );
  },
);

NodeTest.test("reports GitHub 404 and API rate-limit failures clearly", () => {
  NodeAssert.match(classifyGitHubFailure("HTTP 404: Not Found"), /404/);
  NodeAssert.match(classifyGitHubFailure("API rate limit exceeded for user"), /rate limit/i);
  NodeAssert.match(classifyGitHubFailure("socket closed"), /GitHub request failed/);
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
