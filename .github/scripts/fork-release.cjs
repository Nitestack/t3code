const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createReadStream } = require("node:fs");

const RELEASE_REPOSITORY = "get-aix/t3code";
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
// A fork fix on upstream X.Y.Z is X.Y.(Z+1)-aix.N: newer than its base, older than upstream's next.
const FORK_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-aix\.([1-9]\d*))?$/;
const BUILD_ONLY_JOBS = Object.freeze([
  "Build versioned fork Nix package",
  "Verify and package fork installers",
]);

function forkBaseVersion(version) {
  const match = FORK_VERSION.exec(version ?? "");
  if (!match || (match[4] !== undefined && match[3] === "0")) {
    throw new Error(
      `Fork version must be X.Y.Z or X.Y.Z-aix.N on a released X.Y.(Z-1): ${version}`,
    );
  }
  return match[4] === undefined ? version : `${match[1]}.${match[2]}.${Number(match[3]) - 1}`;
}

// Same formula as androidForkVersionCode in apps/mobile/app.config.ts; a fork fix sorts below X.Y.Z.
function forkAndroidVersionCode(version) {
  const match = FORK_VERSION.exec(version);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return (
    (major * 1_000_000 + minor * 1_000 + patch) * 100 +
    (match[4] === undefined ? 99 : Number(match[4]))
  );
}

// baseReleaseSha is the commit of the published v<baseVersion> release, or "" when there is none.
function resolveForkReleaseVersion({ baseVersion, sha, baseReleaseSha = "", forkTags = [] }) {
  if (!STABLE_VERSION.test(baseVersion ?? "") || !COMMIT_SHA.test(sha ?? "")) {
    throw new Error("Fork release version needs a stable base version and a full source SHA.");
  }
  if (baseReleaseSha === "" || baseReleaseSha.toLowerCase() === sha.toLowerCase())
    return baseVersion;
  const [major, minor, patch] = baseVersion.split(".").map(Number);
  const core = `${major}.${minor}.${patch + 1}`;
  let latest = 0;
  for (const tag of forkTags) {
    const match = FORK_VERSION.exec(tag.version);
    if (!match || match[4] === undefined || `${match[1]}.${match[2]}.${match[3]}` !== core)
      continue;
    if (tag.sha.toLowerCase() === sha.toLowerCase()) return tag.version;
    latest = Math.max(latest, Number(match[4]));
  }
  if (latest >= 98)
    throw new Error(`No fork revision left for ${core}; the Android version code allows 98.`);
  return `${core}-aix.${latest + 1}`;
}

function checksummedReleaseAssets(version) {
  return [`T3-Code-${version}-x64.exe`, `T3-Code-${version}.apk`, `T3-Code-${version}-arm64.zip`];
}

// electron-updater feeds: each manifest must list the installer its platform updates from.
function updateManifests(version) {
  return {
    "latest.yml": `T3-Code-${version}-x64.exe`,
    "latest-mac.yml": `T3-Code-${version}-arm64.zip`,
  };
}

function requiredReleaseAssets(version) {
  const [windows, android, macZip] = checksummedReleaseAssets(version);
  return [
    windows,
    `${windows}.sha256`,
    `${windows}.blockmap`,
    "windows-metadata.json",
    android,
    `${android}.sha256`,
    "metadata.json",
    macZip,
    `${macZip}.sha256`,
    `${macZip}.blockmap`,
    "install-macos.sh",
    "install-windows.ps1",
    ...Object.keys(updateManifests(version)),
    "nix-build.json",
    "BUILD-INFO.md",
  ];
}

// Reads the url/sha512 pairs electron-builder writes under `files:`; no YAML dependency in workflows.
function parseUpdateManifest(contents) {
  const version = /^version: ['"]?([^'"\s]+)['"]?$/m.exec(contents)?.[1];
  const files = [];
  for (const line of contents.split(/\r?\n/)) {
    const url = /^\s*- url: ['"]?([^'"]+?)['"]?$/.exec(line);
    if (url) {
      files.push({ url: url[1] });
      continue;
    }
    const sha512 = /^\s+sha512: ['"]?([^'"\s]+)['"]?$/.exec(line);
    const current = files.at(-1);
    if (sha512 && current && current.sha512 === undefined) current.sha512 = sha512[1];
  }
  return { version, files };
}

async function verifyUpdateManifests(directory, version) {
  for (const [manifest, installer] of Object.entries(updateManifests(version))) {
    const { version: manifestVersion, files } = parseUpdateManifest(
      fs.readFileSync(path.join(directory, manifest), "utf8"),
    );
    if (manifestVersion !== version || !files.some((file) => file.url === installer)) {
      throw new Error(`${manifest} does not offer ${installer} for version ${version}.`);
    }
    for (const file of files) {
      const filePath = path.join(directory, file.url);
      if (
        path.basename(file.url) !== file.url ||
        !fs.existsSync(filePath) ||
        (await hashFile(filePath, "sha512", "base64")) !== file.sha512
      ) {
        throw new Error(
          `${manifest} lists ${file.url}, which is missing or has different contents.`,
        );
      }
    }
  }
}

function assertForkReleaseTagTarget({ tag, expectedSha, actualSha }) {
  if (
    typeof tag !== "string" ||
    !COMMIT_SHA.test(expectedSha ?? "") ||
    !COMMIT_SHA.test(actualSha ?? "") ||
    actualSha.toLowerCase() !== expectedSha.toLowerCase()
  ) {
    throw new Error(
      `Existing tag ${tag} points to ${actualSha}, not release source ${expectedSha}.`,
    );
  }
  return true;
}

function decideReleaseBranchUpdate(compareStatus) {
  if (compareStatus === "ahead") return "update";
  if (compareStatus === "identical") return "noop";
  if (compareStatus === "behind" || compareStatus === "diverged") return "skip";
  throw new Error(
    `GitHub returned an unsupported release branch comparison status: ${compareStatus}`,
  );
}

function resolveForkUpstreamBase({
  markerContents,
  explicitBase = "",
  sourceBranch = "main",
  expectedVersion,
  peeledTagCommit,
}) {
  const expectedTag = `v${expectedVersion}`;
  if (!STABLE_VERSION.test(expectedVersion ?? "") || !COMMIT_SHA.test(peeledTagCommit ?? "")) {
    throw new Error(
      "The upstream stable tag and its peeled commit must be verified before release.",
    );
  }
  if (markerContents !== undefined) {
    let marker;
    try {
      marker = JSON.parse(markerContents);
    } catch {
      throw new Error("Upstream stable marker is invalid; refusing to resolve a release base.");
    }
    if (
      !marker ||
      typeof marker !== "object" ||
      typeof marker.tag !== "string" ||
      marker.tag !== expectedTag ||
      !COMMIT_SHA.test(marker.commit) ||
      marker.commit.toLowerCase() !== peeledTagCommit.toLowerCase()
    ) {
      throw new Error("Upstream stable marker is invalid; refusing to resolve a release base.");
    }
    return marker.commit.toLowerCase();
  }

  if (/^automation\/upstream-stable-/.test(sourceBranch)) {
    throw new Error("Upstream stable marker is missing for an automated sync release.");
  }
  if (
    !COMMIT_SHA.test(explicitBase) ||
    explicitBase.toLowerCase() !== peeledTagCommit.toLowerCase()
  ) {
    throw new Error(
      "A missing upstream stable marker requires upstream_base to equal the verified full commit SHA for the matching upstream stable tag.",
    );
  }
  return explicitBase.toLowerCase();
}

function markdownCode(value) {
  const text = String(value);
  const longestFence = [...text.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const fence = "`".repeat(longestFence + 1);
  return `${fence}${text}${fence}`;
}

function buildForkNixBuildSummary({ packageName, sourceSha }) {
  return `Built ${markdownCode(packageName)} from ${markdownCode(sourceSha)}.\n`;
}

function buildForkArtifactSourceMetadata({
  sha,
  upstreamTag,
  upstreamBase,
  buildRunId = "",
  buildRunAttempt = "",
}) {
  return {
    "Fork commit (built source)": sha,
    "Upstream stable base": { tag: upstreamTag, commit: upstreamBase },
    sourceDescription: `Artifacts are built from the fork commit and include fork changes plus upstream through ${upstreamTag}.`,
    "Build Actions run": { id: buildRunId, attempt: buildRunAttempt },
  };
}

function buildForkBuildInfo({
  version,
  sha,
  upstreamTag,
  upstreamBase,
  sourceBranch,
  buildRunId,
  buildRunAttempt,
  publicationMode = "build-only",
}) {
  return [
    "T3 Code build artifacts",
    "",
    `Version: ${version}`,
    `Fork commit (built source): ${markdownCode(sha)}`,
    `Upstream stable base: ${markdownCode(upstreamTag)} = ${markdownCode(upstreamBase)}`,
    `Source branch: ${markdownCode(sourceBranch)}`,
    `Actions build run: ${markdownCode(buildRunId)} (attempt: ${markdownCode(buildRunAttempt)})`,
    "",
    `These artifacts are built from the fork commit and include fork changes plus upstream through ${upstreamTag}.`,
    "",
    "The Windows x64 installer was built with the Linux x64 WSL runtime and its packaged native runtime was verified on the standard Windows 2025 runner. Windows signing status is recorded in windows-metadata.json.",
    "The Android APK was signed with the release upload certificate and verified by the Android build job.",
    "The macOS Apple Silicon zip is signed with the fork's self-signed certificate, not notarized, and passed a launch check on a GitHub macOS runner.",
    "latest.yml and latest-mac.yml are the desktop update feeds; every file they list was checked against its SHA-512.",
    `The matching ${markdownCode(`t3code-${forkBaseVersion(version)}`)} Nix package was built successfully; its exact source and store path are in nix-build.json.`,
    "",
    publicationMode === "authorized-auto-publish"
      ? "This build is part of an explicitly authorized stable release run."
      : "Build-only mode: this run creates no Git tag or GitHub release, including a draft.",
    "Build the matching Nix package from this source with:",
    "",
    "```sh",
    `nix build 'github:get-aix/t3code/${sha}'`,
    "```",
    "",
    "After an authorized release publishes its matching tag, install it with:",
    "",
    "```sh",
    `nix profile add 'github:get-aix/t3code/v${version}'`,
    "```",
    "",
  ].join("\n");
}

function analyzeForkUpstreamHistory({ sourceRangeCommits, upstreamMainCommits }) {
  if (!Array.isArray(sourceRangeCommits) || !Array.isArray(upstreamMainCommits)) {
    throw new Error("Fork and upstream history must be provided as commit lists.");
  }
  if (
    [...sourceRangeCommits, ...upstreamMainCommits].some(
      (commit) => typeof commit !== "string" || !COMMIT_SHA.test(commit),
    )
  ) {
    throw new Error("Fork and upstream history contain an invalid commit SHA.");
  }
  const upstream = new Set(upstreamMainCommits.map((commit) => commit.toLowerCase()));
  const commits = [...new Set(sourceRangeCommits.map((commit) => commit.toLowerCase()))]
    .filter((commit) => upstream.has(commit))
    .toSorted();
  return {
    commits,
    blocked: commits.length > 0,
  };
}

const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const MAX_RELEASE_NOTES_LENGTH = 124_000;
const MAX_FORK_CHANGES_LENGTH = 20_000;

function parseForkVersion(version) {
  const match = FORK_VERSION.exec(version ?? "");
  if (!match || (match[4] !== undefined && match[3] === "0")) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    aix: match[4] === undefined ? null : Number(match[4]),
  };
}

function compareForkVersions(left, right) {
  const a = parseForkVersion(left);
  const b = parseForkVersion(right);
  if (!a || !b) {
    throw new Error(`Invalid fork version comparison: ${left} vs ${right}`);
  }
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.aix === b.aix) return 0;
  if (a.aix === null) return 1;
  if (b.aix === null) return -1;
  return a.aix - b.aix;
}

function selectPreviousForkRelease({ releases, currentVersion }) {
  if (!parseForkVersion(currentVersion)) {
    throw new Error(`Invalid current fork release version: ${currentVersion}`);
  }
  if (!Array.isArray(releases)) {
    throw new Error("Fork releases must be provided as a list.");
  }
  let best = null;
  for (const release of releases) {
    if (!release || release.draft || release.prerelease) continue;
    const tag = typeof release.tag_name === "string" ? release.tag_name : release.tagName;
    if (typeof tag !== "string" || !tag.startsWith("v")) continue;
    const version = tag.slice(1);
    if (!parseForkVersion(version)) continue;
    if (compareForkVersions(version, currentVersion) >= 0) continue;
    if (release.isAncestor === false) continue;
    if (typeof release.sha === "string" && release.sha !== "" && !COMMIT_SHA.test(release.sha)) {
      continue;
    }
    if (!best || compareForkVersions(version, best.version) > 0) {
      best = {
        tag,
        version,
        sha: typeof release.sha === "string" ? release.sha.toLowerCase() : "",
      };
    }
  }
  return best;
}

function countUnclosedDetailsTags(text) {
  const opens = (text.match(/<details\b[^>]*>/gi) ?? []).length;
  const closes = (text.match(/<\/details>/gi) ?? []).length;
  return Math.max(0, opens - closes);
}

function closeDetailsSuffix(text) {
  const unclosed = countUnclosedDetailsTags(text);
  return unclosed > 0 ? `\n\n${"</details>\n".repeat(unclosed).trimEnd()}` : "";
}

function formatUpstreamReleaseNotes({ upstreamNotes, upstreamTag, maxLength }) {
  const upstreamUrl = `https://github.com/${UPSTREAM_REPOSITORY}/releases/tag/${encodeURIComponent(upstreamTag)}`;
  const normalized = String(upstreamNotes ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  const fallback = `See the upstream [T3 Code ${markdownCode(upstreamTag)} release notes](${upstreamUrl}).`;
  if (normalized === "") {
    return fallback;
  }

  const closedNormalized = `${normalized}${closeDetailsSuffix(normalized)}`;
  if (closedNormalized.length <= maxLength) {
    return closedNormalized;
  }

  const notice =
    `\n\n…\n\n_Upstream release notes truncated to fit GitHub's release size limit. ` +
    `See the full [T3 Code ${markdownCode(upstreamTag)} release](${upstreamUrl})._`;
  if (maxLength <= fallback.length) {
    return fallback;
  }

  // Reserve room for the notice plus closing tags for any <details> left open by slicing.
  let limit = Math.max(0, maxLength - notice.length);
  for (let pass = 0; pass < 4; pass += 1) {
    let prefix = normalized.slice(0, limit);
    const lastNewline = prefix.lastIndexOf("\n");
    if (lastNewline > Math.floor(prefix.length * 0.5)) {
      prefix = prefix.slice(0, lastNewline);
    }
    prefix = prefix.trimEnd();
    const candidate = `${prefix}${notice}${closeDetailsSuffix(prefix)}`;
    if (candidate.length <= maxLength) {
      return candidate;
    }
    limit = Math.max(0, limit - (candidate.length - maxLength));
  }
  return fallback;
}

function formatForkCommitLine(commit) {
  if (!commit || typeof commit !== "object") return "";
  const subject = String(commit.subject ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (subject === "") return "";
  const sha = typeof commit.sha === "string" ? commit.sha.trim() : "";
  if (COMMIT_SHA.test(sha)) {
    const shortSha = sha.slice(0, 8);
    return `- ${subject} ([${markdownCode(shortSha)}](https://github.com/${RELEASE_REPOSITORY}/commit/${sha}))`;
  }
  return `- ${subject}`;
}

function buildForkChangesSection({
  forkCommits = [],
  previousReleaseTag = "",
  releaseTag,
  maxLength = MAX_FORK_CHANGES_LENGTH,
}) {
  const lines = Array.isArray(forkCommits)
    ? forkCommits.map(formatForkCommitLine).filter(Boolean)
    : [];
  if (lines.length === 0 && previousReleaseTag === "") {
    return "";
  }

  const heading = previousReleaseTag
    ? `## Fork changes since ${previousReleaseTag}`
    : "## Fork changes";
  const changelogLines = previousReleaseTag
    ? [
        "",
        "### Full Changelog",
        "",
        `https://github.com/${RELEASE_REPOSITORY}/compare/${encodeURIComponent(previousReleaseTag)}...${encodeURIComponent(releaseTag)}`,
      ]
    : [];

  if (lines.length === 0) {
    const prevUrl = `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${encodeURIComponent(previousReleaseTag)}`;
    return [
      heading,
      "",
      `No additional fork changes since [${markdownCode(previousReleaseTag)}](${prevUrl}).`,
      ...changelogLines,
    ].join("\n");
  }

  const fullBody = [heading, "", ...lines, ...changelogLines].join("\n");
  if (fullBody.length <= maxLength) {
    return fullBody;
  }

  const changelogText = changelogLines.join("\n");
  const kept = [];
  const baseOverhead = heading.length + changelogText.length + 120;
  let used = baseOverhead;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const lineLength = lines[i].length + 1;
    if (kept.length > 0 && used + lineLength > maxLength) break;
    kept.push(lines[i]);
    used += lineLength;
  }
  kept.reverse();
  const omitted = lines.length - kept.length;
  const notice = `- … ${omitted} earlier fork commit(s) omitted; see the full changelog below.`;
  return [heading, "", notice, ...kept, ...changelogLines].join("\n");
}

function buildForkReleaseNotes({
  upstreamBase,
  sha,
  sourceBranch,
  buildArtifactRunId,
  buildArtifactRunAttempt,
  upstreamTag,
  releaseTag,
  upstreamNotes = "",
  previousReleaseTag = "",
  forkCommits = [],
}) {
  const isUpstreamMergeRelease = releaseTag === upstreamTag;
  const installAndMetadata = [
    "## Install",
    "",
    `The Windows installer (with WSL runtime), macOS Apple Silicon app, signed Android APK, and versioned Nix package are built from the fork commit and include fork changes plus upstream through ${upstreamTag}. Checksums and build metadata are attached. Installed desktop apps update themselves from fork releases.`,
    "",
    "On Windows, run this in a normal PowerShell window. It needs no admin rights and avoids the SmartScreen block on the unsigned installer:",
    "",
    "```powershell",
    "irm https://github.com/get-aix/t3code/releases/latest/download/install-windows.ps1 | iex",
    "```",
    "",
    "On macOS (Apple Silicon), install only with this command. The app is not notarized, so a zip downloaded in a browser is blocked by Gatekeeper:",
    "",
    "```sh",
    "curl -fsSL https://github.com/get-aix/t3code/releases/latest/download/install-macos.sh | bash",
    "```",
    "",
    "Install the matching Nix build from this release tag:",
    "",
    "```sh",
    `nix profile add 'github:get-aix/t3code/${releaseTag}'`,
    "```",
    "",
    "## Build metadata",
    "",
    `Fork commit (built source): ${markdownCode(sha)}`,
    "",
    `Upstream stable base: ${markdownCode(upstreamTag)} = ${markdownCode(upstreamBase)}`,
    "",
    `Source branch: ${markdownCode(sourceBranch)}`,
    "",
    `Tested build artifact run: ${markdownCode(buildArtifactRunId)} (attempt: ${markdownCode(buildArtifactRunAttempt)})`,
  ].join("\n");

  const forkChangesBudget = Math.min(
    MAX_FORK_CHANGES_LENGTH,
    Math.max(1_000, MAX_RELEASE_NOTES_LENGTH - installAndMetadata.length - 500),
  );
  const forkChangesSection = buildForkChangesSection({
    forkCommits,
    previousReleaseTag,
    releaseTag,
    maxLength: forkChangesBudget,
  });

  const sections = [];
  if (isUpstreamMergeRelease) {
    const upstreamUrl = `https://github.com/${UPSTREAM_REPOSITORY}/releases/tag/${encodeURIComponent(upstreamTag)}`;
    const upstreamHeading = `## Upstream T3 Code ([${markdownCode(upstreamTag)}](${upstreamUrl}))`;
    const separator = "\n\n---\n\n";
    const fixedLength =
      upstreamHeading.length +
      2 +
      (forkChangesSection ? separator.length + forkChangesSection.length : 0) +
      separator.length +
      installAndMetadata.length +
      1;
    const upstreamBody = formatUpstreamReleaseNotes({
      upstreamNotes,
      upstreamTag,
      maxLength: Math.max(0, MAX_RELEASE_NOTES_LENGTH - fixedLength),
    });
    sections.push(`${upstreamHeading}\n\n${upstreamBody}`);
  }

  if (forkChangesSection) {
    sections.push(forkChangesSection);
  }
  sections.push(installAndMetadata);

  return `${sections.join("\n\n---\n\n")}\n`;
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
  const artifactName = `t3-code-installers-${version}-${sha.slice(0, 12)}`;
  if (
    !FORK_VERSION.test(version) ||
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
  return { artifactName, runId, runAttempt: run.run_attempt };
}

function assertExistingForkReleaseMetadata({
  release,
  version,
  sha,
  upstreamBase,
  upstreamTag,
  sourceBranch = "",
}) {
  const expectedTag = `v${version}`;
  const expectedName = `T3 Code ${expectedTag}`;
  const expectedAssets = requiredReleaseAssets(version).toSorted();
  const actualAssets = release?.assets?.map((asset) => asset.name).toSorted();
  const buildRun = /^Tested build artifact run: `([1-9]\d*)` \(attempt: `([1-9]\d*)`\)$/m.exec(
    release?.body ?? "",
  );
  if (
    release?.tag_name !== expectedTag ||
    release.name !== expectedName ||
    release.draft ||
    release.prerelease ||
    !COMMIT_SHA.test(upstreamBase) ||
    typeof release.body !== "string" ||
    !release.body.includes(
      `Upstream stable base: ${markdownCode(upstreamTag)} = ${markdownCode(upstreamBase)}`,
    ) ||
    !release.body.includes(`Fork commit (built source): ${markdownCode(sha)}`) ||
    !release.body.includes(`include fork changes plus upstream through ${upstreamTag}`) ||
    (sourceBranch !== "" &&
      !release.body.includes(`Source branch: ${markdownCode(sourceBranch)}`)) ||
    buildRun === null ||
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

async function hashFile(filename, algorithm = "sha256", encoding = "hex") {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest(encoding);
}

async function verifyForkBuildArtifactAssets({
  directory,
  version,
  sha,
  upstreamBase,
  upstreamTag,
  sourceBranch = "",
  buildRunId = "",
  buildRunAttempt = "",
}) {
  if (
    upstreamTag !== `v${forkBaseVersion(version)}` ||
    !COMMIT_SHA.test(sha) ||
    !COMMIT_SHA.test(upstreamBase)
  ) {
    throw new Error(
      "Build artifact source identity has an invalid version or upstream stable base.",
    );
  }
  const actualAssets = fs.readdirSync(directory).toSorted();
  const expectedAssets = requiredReleaseAssets(version).toSorted();
  const sourceMetadata = buildForkArtifactSourceMetadata({
    sha,
    upstreamTag,
    upstreamBase,
    buildRunId,
    buildRunAttempt,
  });
  if (
    actualAssets.length !== expectedAssets.length ||
    actualAssets.some((name, index) => name !== expectedAssets[index])
  ) {
    throw new Error(
      "Build artifact does not contain the complete expected installer and Nix asset set.",
    );
  }
  const [windows, android] = checksummedReleaseAssets(version);
  const hashes = new Map();
  for (const asset of checksummedReleaseAssets(version)) {
    hashes.set(asset, parseChecksum(directory, asset));
    if ((await hashFile(path.join(directory, asset))) !== hashes.get(asset)) {
      throw new Error("Installer contents do not match their SHA-256 files.");
    }
  }
  const windowsHash = hashes.get(windows);
  const androidHash = hashes.get(android);
  await verifyUpdateManifests(directory, version);

  const readJson = (filename) =>
    JSON.parse(fs.readFileSync(path.join(directory, filename), "utf8"));
  const androidMetadata = readJson("metadata.json");
  const windowsMetadata = readJson("windows-metadata.json");
  const nixMetadata = readJson("nix-build.json");
  const expectedAndroidVersionCode = forkAndroidVersionCode(version);
  const nixStorePath = typeof nixMetadata.storePath === "string" ? nixMetadata.storePath : "";
  const nixStoreName = nixStorePath.startsWith("/nix/store/")
    ? nixStorePath.slice("/nix/store/".length)
    : "";
  const nixStoreHash = nixStoreName.slice(0, 32);
  if (
    androidMetadata.applicationId !== "com.t3tools.t3code" ||
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
    nixMetadata.package !== "t3code" ||
    nixMetadata.version !== forkBaseVersion(version) ||
    nixMetadata.gitSha?.toLowerCase() !== sha.toLowerCase() ||
    [androidMetadata, windowsMetadata, nixMetadata].some((metadata) =>
      Object.entries(sourceMetadata).some(
        ([key, value]) => JSON.stringify(metadata[key]) !== JSON.stringify(value),
      ),
    ) ||
    !/^[a-z0-9]{32}$/.test(nixStoreHash) ||
    nixStoreName.slice(33) !== `t3code-${forkBaseVersion(version)}`
  ) {
    throw new Error(
      "Existing release metadata does not match the fork source, version, or installer contents.",
    );
  }

  const buildInfo = fs.readFileSync(path.join(directory, "BUILD-INFO.md"), "utf8");
  if (
    !buildInfo.includes(`Version: ${version}`) ||
    !buildInfo.includes(`Fork commit (built source): ${markdownCode(sha)}`) ||
    !buildInfo.includes(
      `Upstream stable base: ${markdownCode(upstreamTag)} = ${markdownCode(upstreamBase)}`,
    ) ||
    !buildInfo.includes(`include fork changes plus upstream through ${upstreamTag}`) ||
    (sourceBranch !== "" && !buildInfo.includes(`Source branch: ${markdownCode(sourceBranch)}`)) ||
    (buildRunId !== "" && !buildInfo.includes(`Actions build run: ${markdownCode(buildRunId)}`)) ||
    (buildRunAttempt !== "" && !buildInfo.includes(`attempt: ${markdownCode(buildRunAttempt)}`)) ||
    !buildInfo.includes(`nix build 'github:get-aix/t3code/${sha}'`)
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
  upstreamTag,
  sourceBranch = "",
}) {
  assertExistingForkReleaseMetadata({
    release,
    version,
    sha,
    upstreamBase,
    upstreamTag,
    sourceBranch,
  });
  const buildRun = /^Tested build artifact run: `([1-9]\d*)` \(attempt: `([1-9]\d*)`\)$/m.exec(
    release.body,
  );
  return verifyForkBuildArtifactAssets({
    directory,
    version,
    sha,
    upstreamBase,
    upstreamTag,
    sourceBranch,
    buildRunId: buildRun[1],
    buildRunAttempt: buildRun[2],
  });
}

function resolveForkRelease({
  repository,
  eventName,
  ref,
  channel,
  requestedVersion = "",
  manifestVersions,
  forkVersion = "",
  sha,
  sourceBranch = "",
  upstreamBase = "",
  upstreamTag = "",
  upstreamBaseIsAncestor = false,
  unreleasedUpstreamCommits = [],
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
  const baseVersion = versions[0];
  if (!STABLE_VERSION.test(baseVersion))
    throw new Error(`Application version must be stable MAJOR.MINOR.PATCH: ${baseVersion}`);
  const version = forkVersion || baseVersion;
  if (forkBaseVersion(version) !== baseVersion) {
    throw new Error(`Fork version ${version} is not based on application version ${baseVersion}.`);
  }
  if (requestedVersion && requestedVersion !== version) {
    throw new Error(
      `Requested version ${requestedVersion} does not match application version ${version}.`,
    );
  }
  const tag = `v${version}`;
  const releaseName = `T3 Code ${tag}`;
  const expectedAssets = requiredReleaseAssets(version).toSorted();
  const existingAssetNames = existingRelease?.assets?.map((asset) => asset.name).toSorted();
  if (!COMMIT_SHA.test(upstreamBase)) {
    throw new Error("Release upstream base must be a full 40-character commit SHA.");
  }
  if (upstreamTag !== `v${baseVersion}`) {
    throw new Error(
      `Upstream stable tag ${upstreamTag || "(missing)"} does not match v${baseVersion}.`,
    );
  }
  if (!upstreamBaseIsAncestor) {
    throw new Error("The upstream stable base must be an ancestor of the fork release source.");
  }
  if (unreleasedUpstreamCommits.length > 0) {
    const offending = unreleasedUpstreamCommits.slice(0, 5).map((commit) => commit.slice(0, 12));
    throw new Error(
      `Fork source contains ${unreleasedUpstreamCommits.length} upstream-main commit(s) beyond ${upstreamTag}: ${offending.join(", ")}${unreleasedUpstreamCommits.length > offending.length ? ", …" : ""}. Main accepts stable upstream tags only.`,
    );
  }
  if (sourceBranch && sourceBranch !== "main") {
    const match =
      /^automation\/upstream-stable-(v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([0-9a-f]{8})$/.exec(
        sourceBranch,
      );
    if (
      !match ||
      match[1].replace(/^v/, "") !== version ||
      !COMMIT_SHA.test(upstreamBase) ||
      !upstreamBase.toLowerCase().startsWith(match[2])
    ) {
      throw new Error(
        "Release source branch does not identify this version and upstream base commit.",
      );
    }
  }
  if (existingTagSha)
    assertForkReleaseTagTarget({ tag, expectedSha: sha, actualSha: existingTagSha });
  const alreadyPublished = Boolean(
    existingRelease &&
    existingRelease.tag_name === tag &&
    existingRelease.name === releaseName &&
    !existingRelease.draft &&
    !existingRelease.prerelease &&
    typeof existingRelease.body === "string" &&
    upstreamBase !== "" &&
    existingRelease.body.includes(
      `Upstream stable base: ${markdownCode(upstreamTag)} = ${markdownCode(upstreamBase)}`,
    ) &&
    existingRelease.body.includes(`Fork commit (built source): ${markdownCode(sha)}`) &&
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
  MAX_RELEASE_NOTES_LENGTH,
  RELEASE_REPOSITORY,
  compareForkVersions,
  forkAndroidVersionCode,
  forkBaseVersion,
  resolveForkReleaseVersion,
  selectPreviousForkRelease,
  analyzeForkUpstreamHistory,
  assertForkReleaseTagTarget,
  assertExistingForkReleaseMetadata,
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
};
