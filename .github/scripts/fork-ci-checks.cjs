const FORK_REPOSITORY = "Nitestack/t3code";

const REQUIRED_FORK_CHECKS = Object.freeze([
  "Fork Server",
  "Fork Web",
  "Fork Desktop Build",
  "Fork Mobile Type and Unit",
]);

function selectLatestForkCiRun(runs, { expectedBranch, expectedSha }) {
  if (!Array.isArray(runs)) throw new Error("Fork CI returned an invalid workflow-run list.");
  const candidates = runs.filter(
    (run) =>
      run?.event === "push" &&
      run.headBranch === expectedBranch &&
      run.headSha?.toLowerCase() === expectedSha.toLowerCase(),
  );
  if (candidates.length === 0) {
    throw new Error("No fork CI push run exists for the exact source commit and branch.");
  }
  if (candidates.some((run) => !Number.isSafeInteger(run.databaseId))) {
    throw new Error("Fork CI returned a run without a valid database ID.");
  }
  return candidates.reduce((latest, candidate) =>
    candidate.databaseId > latest.databaseId ? candidate : latest,
  );
}

function validateForkCiCompletion({
  run,
  eventConclusion,
  eventRunId,
  eventAttempt,
  expectedBranch,
  expectedSha,
}) {
  const runId = Number(eventRunId);
  const attempt = Number(eventAttempt);
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("CI completion event does not identify a valid run and attempt.");
  }
  if (
    !run ||
    run.id !== runId ||
    run.path !== ".github/workflows/ci.yml" ||
    run.event !== "push" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    eventConclusion !== "success" ||
    run.run_attempt !== attempt
  ) {
    throw new Error(
      "Only the successful completion of the exact CI run attempt can trigger merge evaluation.",
    );
  }
  if (
    run.head_repository?.full_name?.toLowerCase() !== FORK_REPOSITORY.toLowerCase() ||
    run.head_branch !== expectedBranch ||
    run.head_sha?.toLowerCase() !== expectedSha.toLowerCase()
  ) {
    throw new Error("CI completion event does not match the current fork sync branch head.");
  }
}

function validateForkCiRun({ run, jobs, expectedBranch, expectedSha }) {
  if (
    !run ||
    run.path !== ".github/workflows/ci.yml" ||
    run.event !== "push" ||
    run.status !== "completed"
  ) {
    throw new Error("Fork CI must be a completed push workflow run.");
  }
  if (
    run.head_repository?.full_name?.toLowerCase() !== FORK_REPOSITORY.toLowerCase() ||
    run.head_branch !== expectedBranch ||
    run.head_sha?.toLowerCase() !== expectedSha.toLowerCase()
  ) {
    throw new Error("Fork CI run does not match the current sync branch head.");
  }
  if (run.conclusion !== "success") {
    throw new Error("Fork CI run concluded " + (run.conclusion ?? "without a result") + ".");
  }
  if (!Array.isArray(jobs)) throw new Error("Fork CI returned an invalid job list.");
  const required = new Set();
  for (const job of jobs) {
    if (!REQUIRED_FORK_CHECKS.includes(job?.name)) continue;
    if (required.has(job.name)) throw new Error("Fork CI contains duplicate job " + job.name + ".");
    if (job.conclusion !== "success") {
      throw new Error(
        "Required fork CI job " +
          job.name +
          " concluded " +
          (job.conclusion ?? "without a result") +
          ".",
      );
    }
    required.add(job.name);
  }
  const missing = REQUIRED_FORK_CHECKS.filter((name) => !required.has(name));
  if (missing.length > 0)
    throw new Error("Fork CI is missing required jobs: " + missing.join(", ") + ".");
}

module.exports = {
  FORK_REPOSITORY,
  REQUIRED_FORK_CHECKS,
  selectLatestForkCiRun,
  validateForkCiCompletion,
  validateForkCiRun,
};
