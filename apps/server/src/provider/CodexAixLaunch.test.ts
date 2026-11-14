import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { resolveCodexAixLaunch } from "./CodexAixLaunch.ts";
import type { AixDiscoveryError } from "./AixDiscovery.ts";

const sentinelA = "aix-key-profile-a-sentinel";
const sentinelB = "aix-key-profile-b-sentinel";
const encoder = new TextEncoder();

const mockResult = (stdout: string, code = 0, stderr = "") =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_411),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.make(encoder.encode(stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const withAix = <A>(
  effect: Effect.Effect<
    A,
    AixDiscoveryError | import("./CodexAixLaunch.ts").CodexAixLaunchError,
    ChildProcessSpawner.ChildProcessSpawner
  >,
  response: (profile: string) => {
    readonly stdout: string;
    readonly code?: number;
    readonly stderr?: string;
  },
) =>
  effect.pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const args = (command as unknown as { readonly args: ReadonlyArray<string> }).args;
        const profile = args[1] ?? "";
        const result = response(profile);
        return Effect.succeed(mockResult(result.stdout, result.code, result.stderr));
      }),
    ),
  );

const profileJson = (profile: string, apiKey: string, endpoint: string) =>
  JSON.stringify({
    AIX_PROFILE: profile,
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: `${endpoint.replace(/\/$/u, "")}/v1`,
  });

it.effect("isolates profile keys and builds a transient native Responses provider", () =>
  Effect.gen(function* () {
    const resolve = (profile: string, key: string) =>
      withAix(
        resolveCodexAixLaunch({
          environment: {
            PATH: "/safe/bin",
            OPENAI_API_KEY: "host-auth-must-not-win",
            T3_AIX_PROFILE: profile,
          },
          launchArgs: "",
        }),
        (actualProfile) => ({
          stdout: profileJson(actualProfile, key, `https://gateway.test/${profile}`),
        }),
      );
    const first = yield* resolve("profile-a", sentinelA);
    const second = yield* resolve("profile-b", sentinelB);

    assert.equal(first.environment.T3_AIX_API_KEY, sentinelA);
    assert.equal(second.environment.T3_AIX_API_KEY, sentinelB);
    assert.equal(first.environment.OPENAI_API_KEY, undefined);
    assert.equal(first.environment.T3_AIX_PROFILE, undefined);
    assert.equal(first.environment.PATH, "/safe/bin");
    assert.equal(first.extendEnv, false);
    assert.deepEqual(first.configArgs, [
      "--config",
      'model_provider="t3_aix"',
      "--config",
      'model_providers.t3_aix.name="aix"',
      "--config",
      'model_providers.t3_aix.base_url="https://gateway.test/profile-a/v1"',
      "--config",
      'model_providers.t3_aix.env_key="T3_AIX_API_KEY"',
      "--config",
      'model_providers.t3_aix.wire_api="responses"',
      "--config",
      "model_providers.t3_aix.requires_openai_auth=false",
    ]);
    assert.equal(first.configArgs.includes(sentinelA), false);
    assert.equal(JSON.stringify([first.configArgs, second.configArgs]).includes(sentinelA), false);
    assert.equal(JSON.stringify([first.configArgs, second.configArgs]).includes(sentinelB), false);
    assert.equal(
      first.configArgs.some((arg) => /^model=/u.test(arg)),
      false,
    );
  }),
);

it.effect("normalizes a prefixed URL to one final /v1", () =>
  Effect.gen(function* () {
    const result = yield* withAix(
      resolveCodexAixLaunch({
        environment: { T3_AIX_PROFILE: "prefix" },
        launchArgs: "",
      }),
      (profile) => ({
        stdout: profileJson(profile, sentinelA, "https://gateway.test/tenant/v1"),
      }),
    );
    assert.equal(
      result.configArgs.find((arg) => arg.startsWith("model_providers.t3_aix.base_url=")),
      'model_providers.t3_aix.base_url="https://gateway.test/tenant/v1"',
    );
  }),
);

it.effect("rejects remote plaintext credentials while permitting loopback development", () =>
  Effect.gen(function* () {
    for (const endpoint of [
      "http://remote.example",
      "http://localhost.example",
      "http://127.0.0.1",
      "http://localhost",
      "http://[::1]",
    ]) {
      const result = yield* Effect.result(
        withAix(
          resolveCodexAixLaunch({
            environment: { T3_AIX_PROFILE: "fixture" },
            launchArgs: "",
          }),
          (profile) => ({ stdout: profileJson(profile, sentinelA, endpoint) }),
        ),
      );
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname);
      assert.equal(result._tag, loopback ? "Success" : "Failure");
      if (result._tag === "Failure")
        assert.equal(JSON.stringify(result).includes(sentinelA), false);
    }
  }),
);

it.effect("applies key rotation only to a later native process launch", () =>
  Effect.gen(function* () {
    let currentKey = sentinelA;
    const launch = () =>
      withAix(
        resolveCodexAixLaunch({
          environment: { T3_AIX_PROFILE: "rotating" },
          launchArgs: "",
        }),
        (profile) => ({
          stdout: profileJson(profile, currentKey, "https://gateway.test/rotate"),
        }),
      );

    const runningTurnLaunch = yield* launch();
    currentKey = sentinelB;
    const nextProcessLaunch = yield* launch();

    assert.equal(runningTurnLaunch.environment.T3_AIX_API_KEY, sentinelA);
    assert.equal(nextProcessLaunch.environment.T3_AIX_API_KEY, sentinelB);
    assert.equal(runningTurnLaunch.environment.T3_AIX_API_KEY, sentinelA);
  }),
);

it.effect(
  "rejects native Anthropic endpoints and conflicting model/provider overrides safely",
  () =>
    Effect.gen(function* () {
      const anthropic = yield* Effect.result(
        withAix(
          resolveCodexAixLaunch({
            environment: { T3_AIX_PROFILE: "anthropic" },
            launchArgs: "",
          }),
          (profile) => ({
            stdout: JSON.stringify({
              AIX_PROFILE: profile,
              ANTHROPIC_API_KEY: sentinelA,
              ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
            }),
          }),
        ),
      );
      const conflicts = yield* Effect.forEach(
        [
          '--config model="other"',
          "--config=model_provider=other",
          "--model other",
          "--profile local",
        ],
        (launchArgs) =>
          Effect.result(
            withAix(
              resolveCodexAixLaunch({
                environment: { T3_AIX_PROFILE: "profile-a" },
                launchArgs,
              }),
              () => {
                throw new Error("a conflicting launch must fail before aix is read");
              },
            ),
          ),
      );

      assert.equal(anthropic._tag, "Failure");
      assert.deepEqual(
        conflicts.map(({ _tag }) => _tag),
        ["Failure", "Failure", "Failure", "Failure"],
      );
      assert.equal(JSON.stringify([anthropic, conflicts]).includes(sentinelA), false);
    }),
);

it.effect("redacts expired or malformed profile output", () =>
  Effect.gen(function* () {
    const expired = yield* Effect.result(
      withAix(
        resolveCodexAixLaunch({
          environment: { T3_AIX_PROFILE: "expired" },
          launchArgs: "",
        }),
        () => ({ stdout: "", stderr: `expired ${sentinelA}`, code: 3 }),
      ),
    );
    assert.equal(expired._tag, "Failure");
    assert.equal(JSON.stringify(expired).includes(sentinelA), false);
  }),
);
