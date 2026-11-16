const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REQUIRED_FORK_CHECKS,
  selectLatestForkCiRun,
  validateForkCiCompletion,
  validateForkCiRun,
} = require("./fork-ci-checks.cjs");

const expectedSha = "a".repeat(40);
const expectedBranch = "automation/upstream-stable-v1.2.3-aaaaaaaa";
const workflowRun = {
  id: 123,
  run_attempt: 2,
  path: ".github/workflows/ci.yml",
  event: "push",
  status: "completed",
  conclusion: "success",
  head_repository: { full_name: "Nitestack/t3code" },
  head_branch: expectedBranch,
  head_sha: expectedSha,
};
const jobs = REQUIRED_FORK_CHECKS.map((name) => ({ name, conclusion: "success" }));

test("selects the newest push CI run for the exact sync branch head", () => {
  const runs = [
    { databaseId: 10, event: "push", headBranch: expectedBranch, headSha: expectedSha },
    { databaseId: 12, event: "push", headBranch: expectedBranch, headSha: "b".repeat(40) },
    { databaseId: 11, event: "push", headBranch: expectedBranch, headSha: expectedSha },
    { databaseId: 13, event: "pull_request", headBranch: expectedBranch, headSha: expectedSha },
  ];
  assert.equal(selectLatestForkCiRun(runs, { expectedBranch, expectedSha }).databaseId, 11);
  assert.throws(
    () => selectLatestForkCiRun(runs.slice(1, 2), { expectedBranch, expectedSha }),
    /No fork CI push run exists for the exact source commit and branch/,
  );
});

test("merge evaluation accepts only the exact successful push run attempt on the current branch head", () => {
  const completion = {
    run: workflowRun,
    eventConclusion: "success",
    eventRunId: "123",
    eventAttempt: "2",
    expectedBranch,
    expectedSha,
  };
  assert.doesNotThrow(() => validateForkCiCompletion(completion));
  for (const changes of [
    { eventConclusion: "failure" },
    { run: { ...workflowRun, conclusion: "cancelled" } },
    { run: { ...workflowRun, event: "pull_request" } },
    { eventAttempt: "1" },
    { eventRunId: "124" },
    { run: { ...workflowRun, head_sha: "b".repeat(40) } },
  ]) {
    assert.throws(() => validateForkCiCompletion({ ...completion, ...changes }));
  }
});

test("accepts only completed, successful exact-head CI with every fork job successful", () => {
  assert.doesNotThrow(() =>
    validateForkCiRun({ run: workflowRun, jobs, expectedBranch, expectedSha }),
  );
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral", null]) {
    assert.throws(
      () =>
        validateForkCiRun({
          run: { ...workflowRun, conclusion },
          jobs,
          expectedBranch,
          expectedSha,
        }),
      /concluded/,
    );
  }
  assert.throws(
    () =>
      validateForkCiRun({
        run: { ...workflowRun, status: "in_progress" },
        jobs,
        expectedBranch,
        expectedSha,
      }),
    /completed push workflow run/,
  );
});

test("rejects skipped, missing, duplicate, wrong-source, or other-head fork checks", () => {
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral", null]) {
    assert.throws(
      () =>
        validateForkCiRun({
          run: workflowRun,
          jobs: jobs.map((job, index) => (index === 0 ? { ...job, conclusion } : job)),
          expectedBranch,
          expectedSha,
        }),
      /Required fork CI job/,
    );
  }
  assert.throws(
    () => validateForkCiRun({ run: workflowRun, jobs: jobs.slice(1), expectedBranch, expectedSha }),
    /missing required jobs/,
  );
  assert.throws(
    () =>
      validateForkCiRun({
        run: workflowRun,
        jobs: [...jobs, jobs[0]],
        expectedBranch,
        expectedSha,
      }),
    /duplicate job/,
  );
  assert.throws(
    () =>
      validateForkCiRun({
        run: { ...workflowRun, head_sha: "b".repeat(40) },
        jobs,
        expectedBranch,
        expectedSha,
      }),
    /does not match the current sync branch head/,
  );
  assert.throws(
    () =>
      validateForkCiRun({
        run: { ...workflowRun, head_repository: { full_name: "other/repo" } },
        jobs,
        expectedBranch,
        expectedSha,
      }),
    /does not match the current sync branch head/,
  );
});
