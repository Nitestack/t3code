const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  analyzeForkUpstreamHistory,
  assertExistingForkReleaseMetadata,
  assertForkReleaseTagTarget,
  buildForkArtifactSourceMetadata,
  buildForkBuildInfo,
  buildForkNixBuildSummary,
  buildForkReleaseNotes,
  decideReleaseBranchUpdate,
  requiredReleaseAssets,
  resolveForkUpstreamBase,
  resolveForkRelease,
  validateForkBuildOnlyRun,
  validateForkPublicationMode,
  verifyForkBuildArtifactAssets,
  verifyExistingForkReleaseAssets,
} = require("./fork-release.cjs");
const { REQUIRED_FORK_CHECKS } = require("./fork-ci-checks.cjs");

const sha = "466b0b0968b7b7ae2016d742a52f3407c629564a";
const upstreamBase = "24e77473ecf41bc1f7142529c7911c1c1aae1d76";
const manifestVersions = { server: "0.1.9", desktop: "0.1.9", web: "0.1.9", contracts: "0.1.9" };
const dispatch = {
  repository: "Nitestack/t3code",
  eventName: "workflow_dispatch",
  ref: "refs/heads/main",
  channel: "stable",
  manifestVersions,
  sha,
  upstreamBase,
  upstreamTag: "v0.1.9",
  upstreamBaseIsAncestor: true,
  sourceOnMain: true,
};
const verifiedBase = { expectedVersion: "0.1.9", peeledTagCommit: upstreamBase };

test("release branch moves only forward to newer releases", () => {
  assert.equal(decideReleaseBranchUpdate("ahead"), "update");
  assert.equal(decideReleaseBranchUpdate("identical"), "noop");
  assert.equal(decideReleaseBranchUpdate("behind"), "skip");
  assert.equal(decideReleaseBranchUpdate("diverged"), "skip");
  assert.throws(
    () => decideReleaseBranchUpdate("unknown"),
    /unsupported release branch comparison/,
  );
});

test("upstream base requires a valid marker or an explicit full manual input", () => {
  const markerContents = JSON.stringify({ tag: "v0.1.9", commit: upstreamBase });
  assert.equal(resolveForkUpstreamBase({ markerContents, ...verifiedBase }), upstreamBase);
  assert.equal(
    resolveForkUpstreamBase({
      markerContents: undefined,
      explicitBase: upstreamBase,
      ...verifiedBase,
    }),
    upstreamBase,
  );
  assert.throws(
    () => resolveForkUpstreamBase({ markerContents: undefined, ...verifiedBase }),
    /upstream_base to equal the verified full commit SHA/,
  );
  assert.throws(
    () =>
      resolveForkUpstreamBase({
        markerContents: "{invalid-json",
        explicitBase: upstreamBase,
        ...verifiedBase,
      }),
    /marker is invalid/,
  );
  assert.throws(
    () =>
      resolveForkUpstreamBase({
        markerContents: JSON.stringify({ tag: "v0.1.9", commit: "24e77473ec" }),
        explicitBase: upstreamBase,
        ...verifiedBase,
      }),
    /marker is invalid/,
  );
  assert.throws(
    () =>
      resolveForkUpstreamBase({
        markerContents: undefined,
        explicitBase: upstreamBase,
        sourceBranch: "automation/upstream-stable-v0.1.9-24e77473",
        ...verifiedBase,
      }),
    /marker is missing for an automated sync release/,
  );
  assert.throws(
    () =>
      resolveForkUpstreamBase({
        markerContents: JSON.stringify({ tag: "v0.1.8", commit: upstreamBase }),
        ...verifiedBase,
      }),
    /marker is invalid/,
  );
  assert.throws(
    () =>
      resolveForkUpstreamBase({
        markerContents: JSON.stringify({ tag: "v0.1.9", commit: "f".repeat(40) }),
        ...verifiedBase,
      }),
    /marker is invalid/,
  );
});

test("release notes and summaries preserve backticks and dollar signs", () => {
  const sourceBranch = "manual`$source";
  const releaseNotes = buildForkReleaseNotes({
    upstreamBase,
    sha,
    sourceBranch,
    buildArtifactRunId: "12345",
    buildArtifactRunAttempt: "2",
    upstreamTag: "v0.1.9",
    releaseTag: "v0.1.9",
  });
  const release = {
    tag_name: "v0.1.9",
    name: "T3 Code v0.1.9",
    body: releaseNotes,
    draft: false,
    prerelease: false,
    assets: requiredReleaseAssets("0.1.9").map((name) => ({ name })),
  };
  assert.match(releaseNotes, /Source branch: ``manual`\$source``/);
  assert.match(
    releaseNotes,
    /Fork commit \(built source\): `466b0b0968b7b7ae2016d742a52f3407c629564a`/,
  );
  assert.match(
    releaseNotes,
    /Upstream stable base: `v0\.1\.9` = `24e77473ecf41bc1f7142529c7911c1c1aae1d76`/,
  );
  assert.match(releaseNotes, /include fork changes plus upstream through v0\.1\.9/);
  assert.match(releaseNotes, /nix profile add 'github:Nitestack\/t3code\/v0\.1\.9'/);
  assert.doesNotThrow(() =>
    assertExistingForkReleaseMetadata({
      release,
      version: "0.1.9",
      sha,
      upstreamBase,
      upstreamTag: "v0.1.9",
      sourceBranch,
    }),
  );
  assert.equal(
    buildForkNixBuildSummary({ packageName: "pkg`$name", sourceSha: "sha`$value" }),
    "Built ``pkg`$name`` from ``sha`$value``.\n",
  );
});

test("release assets keep the upstream T3 Code installer names", () => {
  assert.deepEqual(requiredReleaseAssets("0.1.9").slice(0, 5), [
    "T3-Code-0.1.9-x64.exe",
    "T3-Code-0.1.9-x64.exe.sha256",
    "windows-metadata.json",
    "T3-Code-0.1.9.apk",
    "T3-Code-0.1.9.apk.sha256",
  ]);
});

test("manual fork releases use the application version and upstream release identity", () => {
  assert.deepEqual(resolveForkRelease(dispatch), {
    version: "0.1.9",
    tag: "v0.1.9",
    sha,
    releaseName: "T3 Code v0.1.9",
    runner: "ubuntu-latest",
  });
});

test("release tags derive from the synchronized application version and cannot start from a tag push", () => {
  assert.equal(resolveForkRelease(dispatch).tag, "v0.1.9");
  assert.equal(resolveForkRelease({ ...dispatch, requestedVersion: "0.1.9" }).tag, "v0.1.9");
  assert.throws(
    () => resolveForkRelease({ ...dispatch, eventName: "push", ref: "refs/tags/v0.1.9" }),
    /stable workflow dispatch from main/,
  );
  assert.throws(
    () =>
      resolveForkRelease({ ...dispatch, manifestVersions: { ...manifestVersions, web: "0.1.8" } }),
    /must have the same application version/,
  );
  assert.throws(
    () => resolveForkRelease({ ...dispatch, upstreamTag: "v0.1.8" }),
    /does not match v0\.1\.9/,
  );
  assert.throws(
    () => resolveForkRelease({ ...dispatch, upstreamBaseIsAncestor: false }),
    /must be an ancestor of the fork release source/,
  );
});

test("upstream history preflight detects upstream-main commits beyond the stable tag", () => {
  const stableCommit = "a".repeat(40);
  const laterUpstreamCommit = "b".repeat(40);
  const forkCommit = "c".repeat(40);
  assert.deepEqual(
    analyzeForkUpstreamHistory({
      sourceRangeCommits: [forkCommit, laterUpstreamCommit],
      upstreamMainCommits: [stableCommit, laterUpstreamCommit],
    }),
    { commits: [laterUpstreamCommit], blocked: true },
  );
  assert.deepEqual(
    analyzeForkUpstreamHistory({
      sourceRangeCommits: [forkCommit],
      upstreamMainCommits: [stableCommit, laterUpstreamCommit],
    }),
    { commits: [], blocked: false },
  );
  assert.throws(
    () =>
      resolveForkRelease({
        ...dispatch,
        unreleasedUpstreamCommits: [laterUpstreamCommit],
      }),
    /Fork source contains 1 upstream-main commit\(s\) beyond v0\.1\.9: b{12}.*stable upstream tags only/,
  );
});

test("BUILD-INFO generation preserves literal backticks and dollar signs", () => {
  const buildInfo = buildForkBuildInfo({
    version: "0.1.9",
    sha,
    upstreamTag: "v0.1.9",
    upstreamBase,
    sourceBranch: "main`$branch",
    buildRunId: "12345",
    buildRunAttempt: "2",
  });
  assert.match(buildInfo, /Source branch: ``main`\$branch``/);
  assert.match(
    buildInfo,
    /Build-only mode: this run creates no Git tag or GitHub release, including a draft/,
  );
  assert.match(
    buildInfo,
    /nix build 'github:Nitestack\/t3code\/466b0b0968b7b7ae2016d742a52f3407c629564a'/,
  );
  assert.match(
    buildForkBuildInfo({
      version: "0.1.9",
      sha,
      upstreamTag: "v0.1.9",
      upstreamBase,
      sourceBranch: "main",
      buildRunId: "12345",
      buildRunAttempt: "1",
      publicationMode: "authorized-auto-publish",
    }),
    /explicitly authorized stable release run/,
  );
});

test("fork release runs reject upstream repositories, unsupported dispatches, and non-main sources", () => {
  assert.throws(
    () => resolveForkRelease({ ...dispatch, repository: "pingdotgg/t3code" }),
    /only available from Nitestack/,
  );
  assert.throws(
    () => resolveForkRelease({ ...dispatch, channel: "preview" }),
    /stable workflow dispatch from main/,
  );
  assert.throws(
    () => resolveForkRelease({ ...dispatch, ref: "refs/heads/release" }),
    /stable workflow dispatch from main/,
  );
  assert.throws(
    () => resolveForkRelease({ ...dispatch, sourceOnMain: false }),
    /not contained in fork main/,
  );
});

test("release creation refuses a moved tag or an already published release", () => {
  assert.throws(
    () => resolveForkRelease({ ...dispatch, existingTagSha: "0".repeat(40) }),
    /not release source/,
  );
  assert.throws(
    () => resolveForkRelease({ ...dispatch, releaseExists: true }),
    /published releases are immutable/,
  );
  assert.equal(resolveForkRelease({ ...dispatch, existingTagSha: sha }).tag, "v0.1.9");
});

test("release tag reservation accepts only the exact immutable source commit", () => {
  assert.equal(
    assertForkReleaseTagTarget({ tag: "v0.1.9", expectedSha: sha, actualSha: sha }),
    true,
  );
  assert.throws(
    () => assertForkReleaseTagTarget({ tag: "v0.1.9", expectedSha: sha, actualSha: upstreamBase }),
    /not release source/,
  );
});

test("manual publication promotes only a selected tested build-only run", () => {
  assert.equal(validateForkPublicationMode({ publish: false }), "build-only");
  assert.equal(
    validateForkPublicationMode({ publish: true, artifactRunId: "12345" }),
    "promote-tested-artifact",
  );
  assert.equal(
    validateForkPublicationMode({ publish: true, autoPublishAllowed: true }),
    "authorized-auto-publish",
  );
  assert.throws(
    () => validateForkPublicationMode({ publish: true }),
    /must select the successful build-only run that was tested/,
  );
  assert.throws(
    () => validateForkPublicationMode({ publish: true, artifactRunId: "0" }),
    /positive integer/,
  );
  assert.throws(
    () => validateForkPublicationMode({ publish: false, artifactRunId: "12345" }),
    /cannot select a prior artifact/,
  );
});

test("publication accepts only a successful matching build-only run and artifact", () => {
  const artifactName = `t3-code-installers-0.1.9-${sha.slice(0, 12)}`;
  const run = {
    id: 12345,
    path: ".github/workflows/release.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    head_branch: "main",
    repository: { full_name: "Nitestack/t3code" },
    head_repository: { full_name: "Nitestack/t3code" },
    display_title: `Fork build-only stable 0.1.9 source ${sha}`,
  };
  const jobs = [
    { name: "Build versioned fork Nix package", conclusion: "success" },
    { name: "Verify and package fork installers", conclusion: "success" },
  ];
  const artifacts = [{ name: artifactName, expired: false, size_in_bytes: 100 }];
  assert.deepEqual(
    validateForkBuildOnlyRun({
      run,
      jobs,
      artifacts,
      expectedRunId: "12345",
      version: "0.1.9",
      sha,
    }),
    { artifactName, runId: 12345, runAttempt: 1 },
  );
  const rerunArtifactName = artifactName;
  assert.deepEqual(
    validateForkBuildOnlyRun({
      run: { ...run, run_attempt: 2 },
      jobs,
      artifacts: [{ name: rerunArtifactName, expired: false, size_in_bytes: 100 }],
      expectedRunId: "12345",
      version: "0.1.9",
      sha,
    }),
    { artifactName: rerunArtifactName, runId: 12345, runAttempt: 2 },
  );
  assert.throws(
    () =>
      validateForkBuildOnlyRun({
        run: { ...run, run_attempt: 2 },
        jobs,
        artifacts: [{ ...artifacts[0], name: `${artifactName}-attempt-1` }],
        expectedRunId: "12345",
        version: "0.1.9",
        sha,
      }),
    /missing, expired, or incomplete/,
  );
  assert.deepEqual(
    validateForkBuildOnlyRun({
      run: { ...run, display_title: `Fork build-only stable main source ${sha}` },
      jobs,
      artifacts,
      expectedRunId: "12345",
      version: "0.1.9",
      sha,
    }),
    { artifactName, runId: 12345, runAttempt: 1 },
  );
  assert.throws(
    () =>
      validateForkBuildOnlyRun({
        run,
        jobs,
        artifacts,
        expectedRunId: "12346",
        version: "0.1.9",
        sha,
      }),
    /not a successful build-only run/,
  );
  assert.throws(
    () =>
      validateForkBuildOnlyRun({
        run: { ...run, display_title: `Fork build-only stable 0.1.9 source ${"0".repeat(40)}` },
        jobs,
        artifacts,
        expectedRunId: "12345",
        version: "0.1.9",
        sha,
      }),
    /not a successful build-only run/,
  );
  assert.throws(
    () =>
      validateForkBuildOnlyRun({
        run,
        jobs: [...jobs, { name: "Verify and package fork installers", conclusion: "skipped" }],
        artifacts,
        expectedRunId: "12345",
        version: "0.1.9",
        sha,
      }),
    /did not complete its Nix and installer verification jobs/,
  );
  assert.throws(
    () =>
      validateForkBuildOnlyRun({
        run,
        jobs,
        artifacts: [{ ...artifacts[0], expired: true }],
        expectedRunId: "12345",
        version: "0.1.9",
        sha,
      }),
    /missing, expired, or incomplete/,
  );
});

test("sync releases bind their branch to the exact source and upstream version", () => {
  assert.equal(resolveForkRelease({ ...dispatch, sourceBranch: "main" }).tag, "v0.1.9");
  const syncRelease = {
    ...dispatch,
    sourceBranch: `automation/upstream-stable-v0.1.9-${upstreamBase.slice(0, 8)}`,
  };
  assert.equal(resolveForkRelease(syncRelease).tag, "v0.1.9");
  assert.notEqual(syncRelease.sha.slice(0, 8), upstreamBase.slice(0, 8));
  assert.throws(
    () =>
      resolveForkRelease({
        ...syncRelease,
        sourceBranch: `automation/upstream-stable-v0.1.10-${upstreamBase.slice(0, 8)}`,
      }),
    /does not identify this version and upstream base commit/,
  );
  assert.throws(
    () =>
      resolveForkRelease({
        ...syncRelease,
        sourceBranch: "automation/upstream-stable-v0.1.9-466b0b09",
      }),
    /does not identify this version and upstream base commit/,
  );
});

test("an existing release is idempotent only with its exact source and complete installer assets", () => {
  const assets = requiredReleaseAssets("0.1.9").map((name) => ({ name }));
  const existingRelease = {
    tag_name: "v0.1.9",
    name: "T3 Code v0.1.9",
    body: buildForkReleaseNotes({
      upstreamBase,
      sha,
      sourceBranch: "main",
      buildArtifactRunId: "12345",
      buildArtifactRunAttempt: "1",
      upstreamTag: "v0.1.9",
      releaseTag: "v0.1.9",
    }),
    draft: false,
    prerelease: false,
    assets,
  };
  assert.deepEqual(
    resolveForkRelease({
      ...dispatch,
      existingTagSha: sha,
      releaseExists: true,
      existingRelease,
      existingAssetsVerified: true,
    }),
    {
      version: "0.1.9",
      tag: "v0.1.9",
      sha,
      releaseName: "T3 Code v0.1.9",
      runner: "ubuntu-latest",
      alreadyPublished: true,
    },
  );
  assert.throws(
    () =>
      resolveForkRelease({
        ...dispatch,
        existingTagSha: sha,
        releaseExists: true,
        existingRelease: { ...existingRelease, assets: assets.slice(1) },
      }),
    /complete fork source and asset identity/,
  );
  assert.throws(
    () =>
      resolveForkRelease({
        ...dispatch,
        upstreamBase: "f".repeat(40),
        existingTagSha: sha,
        releaseExists: true,
        existingRelease,
        existingAssetsVerified: true,
      }),
    /complete fork source and asset identity/,
  );
  assert.equal(REQUIRED_FORK_CHECKS.length, 4);
});

test("existing release assets must have matching source metadata and file checksums", async () => {
  const gitCommonDir = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: __dirname, encoding: "utf8" },
  ).trim();
  const directory = fs.mkdtempSync(path.join(gitCommonDir, "fork-release-assets-"));
  const windows = "T3-Code-0.1.9-x64.exe";
  const android = "T3-Code-0.1.9.apk";
  const macZip = "T3-Code-0.1.9-arm64.zip";
  const digest = (contents) => crypto.createHash("sha256").update(contents).digest("hex");
  const baseMetadata = {
    tag_name: "v0.1.9",
    name: "T3 Code v0.1.9",
    body: buildForkReleaseNotes({
      upstreamBase,
      sha,
      sourceBranch: "main",
      buildArtifactRunId: "12345",
      buildArtifactRunAttempt: "1",
      upstreamTag: "v0.1.9",
      releaseTag: "v0.1.9",
    }),
    draft: false,
    prerelease: false,
    assets: requiredReleaseAssets("0.1.9").map((name) => ({ name })),
  };
  try {
    const windowsBytes = Buffer.from("windows installer bytes");
    const androidBytes = Buffer.from("signed apk bytes");
    for (const mac of [macZip, "T3-Code-0.1.9-arm64.dmg"]) {
      fs.writeFileSync(path.join(directory, mac), mac);
      fs.writeFileSync(path.join(directory, `${mac}.sha256`), `${digest(mac)}  ${mac}\n`);
    }
    fs.writeFileSync(path.join(directory, "install-macos.sh"), "#!/bin/bash\n");
    fs.writeFileSync(path.join(directory, windows), windowsBytes);
    fs.writeFileSync(path.join(directory, android), androidBytes);
    fs.writeFileSync(
      path.join(directory, `${windows}.sha256`),
      `${digest(windowsBytes)}  ${windows}\n`,
    );
    fs.writeFileSync(
      path.join(directory, `${android}.sha256`),
      `${digest(androidBytes)}  ${android}\n`,
    );
    fs.writeFileSync(
      path.join(directory, "metadata.json"),
      JSON.stringify({
        applicationId: "com.t3tools.t3code",
        versionName: "0.1.9",
        versionCode: 1009,
        gitSha: sha,
        sha256: digest(androidBytes),
        ...buildForkArtifactSourceMetadata({
          sha,
          upstreamTag: "v0.1.9",
          upstreamBase,
          buildRunId: "12345",
          buildRunAttempt: "1",
        }),
      }),
    );
    fs.writeFileSync(
      path.join(directory, "windows-metadata.json"),
      JSON.stringify({
        application: "T3 Code",
        platform: "windows",
        architecture: "x64",
        version: "0.1.9",
        gitSha: sha,
        installer: windows,
        windowsSigning: "unsigned",
        sha256: digest(windowsBytes),
        ...buildForkArtifactSourceMetadata({
          sha,
          upstreamTag: "v0.1.9",
          upstreamBase,
          buildRunId: "12345",
          buildRunAttempt: "1",
        }),
      }),
    );
    fs.writeFileSync(
      path.join(directory, "nix-build.json"),
      JSON.stringify({
        package: "t3code",
        version: "0.1.9",
        gitSha: sha,
        storePath: `/nix/store/${"a".repeat(32)}-t3code-0.1.9`,
        ...buildForkArtifactSourceMetadata({
          sha,
          upstreamTag: "v0.1.9",
          upstreamBase,
          buildRunId: "12345",
          buildRunAttempt: "1",
        }),
      }),
    );
    fs.writeFileSync(
      path.join(directory, "BUILD-INFO.md"),
      buildForkBuildInfo({
        version: "0.1.9",
        sha,
        upstreamTag: "v0.1.9",
        upstreamBase,
        sourceBranch: "main",
        buildRunId: "12345",
        buildRunAttempt: "1",
      }),
    );

    await assert.doesNotReject(() =>
      verifyExistingForkReleaseAssets({
        release: baseMetadata,
        directory,
        version: "0.1.9",
        sha,
        upstreamBase,
        upstreamTag: "v0.1.9",
      }),
    );
    await assert.doesNotReject(() =>
      verifyForkBuildArtifactAssets({
        directory,
        version: "0.1.9",
        sha,
        upstreamBase,
        upstreamTag: "v0.1.9",
        sourceBranch: "main",
        buildRunId: "12345",
        buildRunAttempt: "1",
      }),
    );
    await assert.rejects(
      verifyForkBuildArtifactAssets({
        directory,
        version: "0.1.9",
        sha,
        upstreamBase,
        upstreamTag: "v0.1.9",
        sourceBranch: "automation/upstream-stable-v0.1.9-deadbeef",
        buildRunId: "12345",
        buildRunAttempt: "1",
      }),
      /source identity/,
    );
    fs.appendFileSync(path.join(directory, macZip), "tampered");
    await assert.rejects(
      verifyForkBuildArtifactAssets({
        directory,
        version: "0.1.9",
        sha,
        upstreamBase,
        upstreamTag: "v0.1.9",
      }),
      /contents do not match/,
    );
    fs.writeFileSync(path.join(directory, macZip), macZip);
    fs.appendFileSync(path.join(directory, windows), "tampered");
    await assert.rejects(
      verifyExistingForkReleaseAssets({
        release: baseMetadata,
        directory,
        version: "0.1.9",
        sha,
        upstreamBase,
        upstreamTag: "v0.1.9",
      }),
      /contents do not match/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual version overrides cannot diverge from product versions", () => {
  assert.throws(
    () => resolveForkRelease({ ...dispatch, requestedVersion: "0.2.0" }),
    /does not match application version/,
  );
  assert.throws(
    () =>
      resolveForkRelease({
        ...dispatch,
        manifestVersions: Object.fromEntries(
          Object.keys(manifestVersions).map((key) => [key, "0.1.9-fork.1"]),
        ),
      }),
    /must be stable MAJOR.MINOR.PATCH/,
  );
});

test("fork releases select GitHub-hosted runners after checking the repository", () => {
  assert.equal(resolveForkRelease(dispatch).runner, "ubuntu-latest");
  assert.throws(
    () => resolveForkRelease({ ...dispatch, repository: "pingdotgg/t3code" }),
    /only available from Nitestack/,
  );
});
