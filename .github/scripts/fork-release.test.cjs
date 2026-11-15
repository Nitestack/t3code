const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertExistingForkReleaseMetadata,
  buildForkNixBuildSummary,
  buildForkReleaseNotes,
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
  sourceOnMain: true,
};

test("upstream base requires a valid marker or an explicit full manual input", () => {
  const markerContents = JSON.stringify({ tag: "v0.1.9", commit: upstreamBase });
  assert.equal(resolveForkUpstreamBase({ markerContents }), upstreamBase);
  assert.equal(
    resolveForkUpstreamBase({ markerContents: undefined, explicitBase: upstreamBase }),
    upstreamBase,
  );
  assert.throws(
    () => resolveForkUpstreamBase({ markerContents: undefined }),
    /requires the upstream_base input to be a full 40-character commit SHA/,
  );
  assert.throws(
    () =>
      resolveForkUpstreamBase({
        markerContents: "{invalid-json",
        explicitBase: upstreamBase,
      }),
    /marker is invalid/,
  );
  assert.throws(
    () =>
      resolveForkUpstreamBase({
        markerContents: JSON.stringify({ tag: "v0.1.9", commit: "24e77473ec" }),
        explicitBase: upstreamBase,
      }),
    /marker is invalid/,
  );
  assert.throws(
    () =>
      resolveForkUpstreamBase({
        markerContents: undefined,
        explicitBase: upstreamBase,
        sourceBranch: "automation/upstream-stable-v0.1.9-24e77473",
      }),
    /marker is missing for an automated sync release/,
  );
});

test("release notes and summaries preserve backticks and dollar signs", () => {
  const sourceBranch = "manual`$source";
  const releaseNotes = buildForkReleaseNotes({
    upstreamBase,
    sha,
    sourceBranch,
    buildArtifactRunId: "12345",
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
  assert.match(releaseNotes, /nix profile add 'github:Nitestack\/t3code\/v0\.1\.9#t3code-fork'/);
  assert.doesNotThrow(() =>
    assertExistingForkReleaseMetadata({
      release,
      version: "0.1.9",
      sha,
      upstreamBase,
      sourceBranch,
    }),
  );
  assert.equal(
    buildForkNixBuildSummary({ packageName: "pkg`$name", sourceSha: "sha`$value" }),
    "Built ``pkg`$name`` from ``sha`$value``.\n",
  );
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
  const artifactName = `t3-code-nitestack-installers-0.1.9-${sha.slice(0, 12)}-attempt-1`;
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
    { artifactName, runId: 12345 },
  );
  const rerunArtifactName = `t3-code-nitestack-installers-0.1.9-${sha.slice(0, 12)}-attempt-2`;
  assert.deepEqual(
    validateForkBuildOnlyRun({
      run: { ...run, run_attempt: 2 },
      jobs,
      artifacts: [{ name: rerunArtifactName, expired: false, size_in_bytes: 100 }],
      expectedRunId: "12345",
      version: "0.1.9",
      sha,
    }),
    { artifactName: rerunArtifactName, runId: 12345 },
  );
  assert.throws(
    () =>
      validateForkBuildOnlyRun({
        run: { ...run, run_attempt: 2 },
        jobs,
        artifacts,
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
    { artifactName, runId: 12345 },
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
  assert.equal(syncRelease.sha.startsWith(syncRelease.sourceBranch.slice(-8)), false);
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
  const windows = "t3-code-nitestack-0.1.9-windows-x64.exe";
  const android = "t3-code-nitestack-0.1.9.apk";
  const digest = (contents) => crypto.createHash("sha256").update(contents).digest("hex");
  const baseMetadata = {
    tag_name: "v0.1.9",
    name: "T3 Code v0.1.9",
    body: buildForkReleaseNotes({
      upstreamBase,
      sha,
      sourceBranch: "main",
      buildArtifactRunId: "12345",
      releaseTag: "v0.1.9",
    }),
    draft: false,
    prerelease: false,
    assets: requiredReleaseAssets("0.1.9").map((name) => ({ name })),
  };
  try {
    const windowsBytes = Buffer.from("windows installer bytes");
    const androidBytes = Buffer.from("signed apk bytes");
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
        applicationId: "com.nitestack.t3code",
        versionName: "0.1.9",
        versionCode: 1009,
        gitSha: sha,
        sha256: digest(androidBytes),
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
      }),
    );
    fs.writeFileSync(
      path.join(directory, "nix-build.json"),
      JSON.stringify({
        package: "t3code-fork",
        version: "0.1.9",
        gitSha: sha,
        storePath: `/nix/store/${"a".repeat(32)}-t3code-fork-0.1.9`,
      }),
    );
    fs.writeFileSync(
      path.join(directory, "BUILD-INFO.md"),
      [
        "Version: 0.1.9",
        `Fork commit: ${sha}`,
        `Upstream base: ${upstreamBase}`,
        "Source branch: main",
        "Build-only Actions run: 12345",
        `nix build 'github:Nitestack/t3code/${sha}#t3code-fork'`,
      ].join("\n"),
    );

    await assert.doesNotReject(() =>
      verifyExistingForkReleaseAssets({
        release: baseMetadata,
        directory,
        version: "0.1.9",
        sha,
        upstreamBase,
      }),
    );
    await assert.doesNotReject(() =>
      verifyForkBuildArtifactAssets({
        directory,
        version: "0.1.9",
        sha,
        upstreamBase,
        sourceBranch: "main",
        buildRunId: "12345",
      }),
    );
    await assert.rejects(
      verifyForkBuildArtifactAssets({
        directory,
        version: "0.1.9",
        sha,
        upstreamBase,
        sourceBranch: "automation/upstream-stable-v0.1.9-deadbeef",
        buildRunId: "12345",
      }),
      /source identity/,
    );
    fs.appendFileSync(path.join(directory, windows), "tampered");
    await assert.rejects(
      verifyExistingForkReleaseAssets({
        release: baseMetadata,
        directory,
        version: "0.1.9",
        sha,
        upstreamBase,
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
