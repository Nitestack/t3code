const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createReadStream } = require("node:fs");

const RELEASE_REPOSITORY = "Nitestack/t3code";
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const BUILD_ONLY_JOBS = Object.freeze([
  "Build versioned fork Nix package",
  "Verify and package fork installers",
]);

function requiredReleaseAssets(version) {
  const windows = `t3-code-nitestack-${version}-windows-x64.exe`;
  const android = `t3-code-nitestack-${version}.apk`;
  return [
    windows,
    `${windows}.sha256`,
    "windows-metadata.json",
    android,
    `${android}.sha256`,
    "metadata.json",
    "nix-build.json",
    "BUILD-INFO.md",
  ];
}

function validateForkPublicationMode({ publish, artifactRunId = "", autoPublishAllowed = false }) {
  if (typeof publish !== "boolean" || typeof autoPublishAllowed !== "boolean") {
    throw new Error("Fork publication mode must use explicit boolean inputs.");
  }
  if (!publish && artifactRunId !== "") {
    throw new Error("A build-only run cannot select a prior artifact for publication.");
  }
  if (!publish) return "build-only";
  if (/^[1-9]\d*$/.test(artifactRunId) && Number.isSafeInteger(Number(artifactRunId))) {
    return "promote-tested-artifact";
  }
  if (artifactRunId !== "") {
    throw new Error("The tested artifact run id must be a positive integer.");
  }
  if (!autoPublishAllowed) {
    throw new Error(
      "Manual publication must select the successful build-only run that was tested; same-run publication requires the explicit automatic-publication setting.",
    );
  }
  return "authorized-auto-publish";
}

function validateForkBuildOnlyRun({ run, jobs, artifacts, expectedRunId, version, sha }) {
  const runId = Number(expectedRunId);
  const artifactName = `t3-code-nitestack-installers-${version}-${sha.slice(0, 12)}-attempt-${run?.run_attempt}`;
  if (
    !STABLE_VERSION.test(version) ||
    !COMMIT_SHA.test(sha) ||
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !run ||
    run.id !== runId ||
    run.path !== ".github/workflows/release.yml" ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    run.head_branch !== "main" ||
    run.repository?.full_name?.toLowerCase() !== RELEASE_REPOSITORY.toLowerCase() ||
    run.head_repository?.full_name?.toLowerCase() !== RELEASE_REPOSITORY.toLowerCase() ||
    ![
      `Fork build-only stable ${version} source ${sha}`,
      `Fork build-only stable main source ${sha}`,
    ].includes(run.display_title)
  ) {
    throw new Error(
      "Selected artifact run is not a successful build-only run for this exact source.",
    );
  }
  if (!Array.isArray(jobs)) throw new Error("Selected artifact run returned an invalid job list.");
  const successfulJobs = new Set();
  for (const job of jobs) {
    if (!BUILD_ONLY_JOBS.includes(job?.name)) continue;
    if (successfulJobs.has(job.name) || job.conclusion !== "success") {
      throw new Error(
        "Selected artifact run did not complete its Nix and installer verification jobs.",
      );
    }
    successfulJobs.add(job.name);
  }
  if (BUILD_ONLY_JOBS.some((name) => !successfulJobs.has(name))) {
    throw new Error(
      "Selected artifact run is missing successful Nix and installer verification jobs.",
    );
  }
  if (!Array.isArray(artifacts))
    throw new Error("Selected artifact run returned an invalid artifact list.");
  const matches = artifacts.filter((artifact) => artifact?.name === artifactName);
  if (
    matches.length !== 1 ||
    matches[0].expired !== false ||
    !Number.isSafeInteger(matches[0].size_in_bytes) ||
    matches[0].size_in_bytes < 1
  ) {
    throw new Error("Selected build-only artifact is missing, expired, or incomplete.");
  }
  return { artifactName, runId };
}

function assertExistingForkReleaseMetadata({
  release,
  version,
  sha,
  upstreamBase,
  sourceBranch = "",
}) {
  const expectedTag = `v${version}`;
  const expectedName = `T3 Code ${expectedTag}`;
  const expectedAssets = requiredReleaseAssets(version).toSorted();
  const actualAssets = release?.assets?.map((asset) => asset.name).toSorted();
  const buildRunId = /^Tested build artifact run: `([1-9]\d*)`$/m.exec(release?.body ?? "")?.[1];
  if (
    release?.tag_name !== expectedTag ||
    release.name !== expectedName ||
    release.draft ||
    release.prerelease ||
    typeof release.body !== "string" ||
    !release.body.includes(`Upstream base: \`${upstreamBase}\``) ||
    !release.body.includes(`Fork commit: \`${sha}\``) ||
    (sourceBranch !== "" && !release.body.includes(`Source branch: \`${sourceBranch}\``)) ||
    buildRunId === undefined ||
    !Array.isArray(actualAssets) ||
    actualAssets.length !== expectedAssets.length ||
    actualAssets.some((name, index) => name !== expectedAssets[index])
  ) {
    throw new Error(
      "Existing release metadata does not match the complete fork source and asset identity.",
    );
  }
}

function parseChecksum(directory, filename) {
  const contents = fs.readFileSync(path.join(directory, `${filename}.sha256`), "utf8").trim();
  const match = /^([a-f0-9]{64})\s+(.+)$/.exec(contents);
  if (!match || match[2] !== filename) {
    throw new Error(`Checksum file for ${filename} is malformed or names a different asset.`);
  }
  return match[1];
}

async function hashFile(filename) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyForkBuildArtifactAssets({
  directory,
  version,
  sha,
  upstreamBase,
  sourceBranch = "",
  buildRunId = "",
}) {
  const actualAssets = fs.readdirSync(directory).toSorted();
  const expectedAssets = requiredReleaseAssets(version).toSorted();
  if (
    actualAssets.length !== expectedAssets.length ||
    actualAssets.some((name, index) => name !== expectedAssets[index])
  ) {
    throw new Error(
      "Build artifact does not contain the complete expected installer and Nix asset set.",
    );
  }
  const windows = `t3-code-nitestack-${version}-windows-x64.exe`;
  const android = `t3-code-nitestack-${version}.apk`;
  const windowsHash = parseChecksum(directory, windows);
  const androidHash = parseChecksum(directory, android);
  if (
    (await hashFile(path.join(directory, windows))) !== windowsHash ||
    (await hashFile(path.join(directory, android))) !== androidHash
  ) {
    throw new Error("Installer contents do not match their SHA-256 files.");
  }

  const readJson = (filename) =>
    JSON.parse(fs.readFileSync(path.join(directory, filename), "utf8"));
  const androidMetadata = readJson("metadata.json");
  const windowsMetadata = readJson("windows-metadata.json");
  const nixMetadata = readJson("nix-build.json");
  const [major, minor, patch] = version.split(".").map(Number);
  const expectedAndroidVersionCode = major * 1_000_000 + minor * 1_000 + patch;
  const nixStorePath = typeof nixMetadata.storePath === "string" ? nixMetadata.storePath : "";
  const nixStoreName = nixStorePath.startsWith("/nix/store/")
    ? nixStorePath.slice("/nix/store/".length)
    : "";
  const nixStoreHash = nixStoreName.slice(0, 32);
  if (
    androidMetadata.applicationId !== "com.nitestack.t3code" ||
    androidMetadata.versionName !== version ||
    androidMetadata.versionCode !== expectedAndroidVersionCode ||
    androidMetadata.gitSha?.toLowerCase() !== sha.toLowerCase() ||
    androidMetadata.sha256 !== androidHash ||
    windowsMetadata.application !== "T3 Code" ||
    windowsMetadata.platform !== "windows" ||
    windowsMetadata.architecture !== "x64" ||
    windowsMetadata.version !== version ||
    windowsMetadata.gitSha?.toLowerCase() !== sha.toLowerCase() ||
    windowsMetadata.installer !== windows ||
    windowsMetadata.sha256 !== windowsHash ||
    !["signed", "unsigned"].includes(windowsMetadata.windowsSigning) ||
    nixMetadata.package !== "t3code-fork" ||
    nixMetadata.version !== version ||
    nixMetadata.gitSha?.toLowerCase() !== sha.toLowerCase() ||
    !/^[a-z0-9]{32}$/.test(nixStoreHash) ||
    nixStoreName.slice(33) !== `t3code-fork-${version}`
  ) {
    throw new Error(
      "Existing release metadata does not match the fork source, version, or installer contents.",
    );
  }

  const buildInfo = fs.readFileSync(path.join(directory, "BUILD-INFO.md"), "utf8");
  if (
    !buildInfo.includes(`Version: ${version}`) ||
    !buildInfo.includes(`Fork commit: ${sha}`) ||
    !buildInfo.includes(`Upstream base: ${upstreamBase}`) ||
    (sourceBranch !== "" && !buildInfo.includes(`Source branch: ${sourceBranch}`)) ||
    (buildRunId !== "" && !buildInfo.includes(`Build-only Actions run: ${buildRunId}`)) ||
    !buildInfo.includes(`nix build 'github:Nitestack/t3code/${sha}#t3code-fork'`)
  ) {
    throw new Error("Build information does not match its source identity.");
  }
  return true;
}

async function verifyExistingForkReleaseAssets({
  release,
  directory,
  version,
  sha,
  upstreamBase,
  sourceBranch = "",
}) {
  assertExistingForkReleaseMetadata({ release, version, sha, upstreamBase, sourceBranch });
  const buildRunId = /^Tested build artifact run: `([1-9]\d*)`$/m.exec(release.body)[1];
  return verifyForkBuildArtifactAssets({
    directory,
    version,
    sha,
    upstreamBase,
    sourceBranch,
    buildRunId,
  });
}

function resolveForkRelease({
  repository,
  eventName,
  ref,
  channel,
  requestedVersion = "",
  manifestVersions,
  sha,
  sourceBranch = "",
  upstreamBase = "",
  sourceOnMain,
  existingTagSha = "",
  releaseExists = false,
  existingRelease,
  existingAssetsVerified = false,
}) {
  if (repository !== RELEASE_REPOSITORY) {
    throw new Error(`Fork releases are only available from ${RELEASE_REPOSITORY}.`);
  }

  if (eventName !== "workflow_dispatch" || channel !== "stable" || ref !== "refs/heads/main") {
    throw new Error("Fork releases require a stable workflow dispatch from main.");
  }

  if (!COMMIT_SHA.test(sha)) throw new Error("Release source must be a full commit SHA.");
  if (!sourceOnMain) throw new Error(`Release source ${sha} is not contained in fork main.`);

  const versions = Object.values(manifestVersions);
  if (versions.length === 0 || versions.some((version) => version !== versions[0])) {
    throw new Error("Server, desktop, web, and contracts must have the same application version.");
  }
  const version = versions[0];
  if (!STABLE_VERSION.test(version))
    throw new Error(`Application version must be stable MAJOR.MINOR.PATCH: ${version}`);
  if (requestedVersion && requestedVersion !== version) {
    throw new Error(
      `Requested version ${requestedVersion} does not match application version ${version}.`,
    );
  }
  const tag = `v${version}`;
  const releaseName = `T3 Code ${tag}`;
  const expectedAssets = requiredReleaseAssets(version).toSorted();
  const existingAssetNames = existingRelease?.assets?.map((asset) => asset.name).toSorted();
  if (sourceBranch && sourceBranch !== "main") {
    const match =
      /^automation\/upstream-stable-(v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([0-9a-f]{8})$/.exec(
        sourceBranch,
      );
    if (
      !match ||
      match[1].replace(/^v/, "") !== version ||
      typeof upstreamBase !== "string" ||
      !/^[0-9a-f]{8,64}$/i.test(upstreamBase) ||
      !upstreamBase.toLowerCase().startsWith(match[2])
    ) {
      throw new Error(
        "Release source branch does not identify this version and upstream base commit.",
      );
    }
  }
  if (existingTagSha && existingTagSha !== sha) {
    throw new Error(`Existing tag ${tag} points to ${existingTagSha}, not release source ${sha}.`);
  }
  const alreadyPublished = Boolean(
    existingRelease &&
    existingRelease.tag_name === tag &&
    existingRelease.name === releaseName &&
    !existingRelease.draft &&
    !existingRelease.prerelease &&
    typeof existingRelease.body === "string" &&
    upstreamBase !== "" &&
    existingRelease.body.includes(`Upstream base: \`${upstreamBase}\``) &&
    existingRelease.body.includes(`Fork commit: \`${sha}\``) &&
    Array.isArray(existingAssetNames) &&
    existingAssetNames.length === expectedAssets.length &&
    existingAssetNames.every((asset, index) => asset === expectedAssets[index]) &&
    existingAssetsVerified &&
    existingTagSha === sha,
  );
  if (releaseExists && !alreadyPublished) {
    throw new Error(
      `Release ${tag} already exists but does not match the complete fork source and asset identity; published releases are immutable.`,
    );
  }

  if (alreadyPublished) {
    return { version, tag, sha, releaseName, runner: "ubuntu-latest", alreadyPublished: true };
  }

  return { version, tag, sha, releaseName: `T3 Code ${tag}`, runner: "ubuntu-latest" };
}

module.exports = {
  RELEASE_REPOSITORY,
  assertExistingForkReleaseMetadata,
  requiredReleaseAssets,
  resolveForkRelease,
  validateForkBuildOnlyRun,
  validateForkPublicationMode,
  verifyForkBuildArtifactAssets,
  verifyExistingForkReleaseAssets,
};
