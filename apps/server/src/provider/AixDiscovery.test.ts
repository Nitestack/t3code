import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { AixDiscoveryError, listModels, listProfiles, resolveEnvironment } from "./AixDiscovery.ts";

const secretSentinel = "aix-secret-sentinel-do-not-leak";
const encoder = new TextEncoder();

type CommandResult = { readonly stdout: string; readonly stderr?: string; readonly code?: number };

function mockHandle(result: CommandResult, onKill: () => void = () => undefined) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_401),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.sync(onKill),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function withAix<A>(
  effect: Effect.Effect<A, AixDiscoveryError, ChildProcessSpawner.ChildProcessSpawner>,
  handler: (args: ReadonlyArray<string>) => CommandResult,
): Effect.Effect<A, AixDiscoveryError> {
  const spawner = ChildProcessSpawner.make((command) => {
    const args = (command as unknown as { readonly args: ReadonlyArray<string> }).args;
    return Effect.succeed(mockHandle(handler(args)));
  });
  return effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
}

const profilesJson = JSON.stringify({
  schema_version: 1,
  command: "profiles",
  data: [
    { name: "gateway-one", label: "Engineering" },
    { name: "gateway-two", label: "Research" },
    { name: "native", label: "Anthropic Production" },
  ],
});

it.effect("reads dynamic profile labels and model IDs from aix JSON envelopes", () =>
  Effect.gen(function* () {
    const profiles = yield* withAix(listProfiles(), (args) => {
      assert.deepEqual(args, ["profiles", "--json"]);
      return { stdout: profilesJson };
    });
    const models = yield* withAix(listModels("gateway-one"), (args) => {
      assert.deepEqual(args, ["--json", "models", "gateway-one"]);
      return {
        stdout: JSON.stringify({
          schema_version: 1,
          command: "models",
          data: { models: [{ id: "gateway/original-model-id" }], filter: null },
        }),
      };
    });

    assert.deepEqual(profiles, [
      { name: "gateway-one", label: "Engineering" },
      { name: "gateway-two", label: "Research" },
      { name: "native", label: "Anthropic Production" },
    ]);
    assert.deepEqual(models, [{ id: "gateway/original-model-id" }]);
    assert.equal(JSON.stringify({ profiles, models }).includes(secretSentinel), false);
  }),
);

it.effect("resolves distinct LiteLLM endpoints and the official Anthropic endpoint", () =>
  Effect.gen(function* () {
    const resolve = (profile: string) =>
      withAix(resolveEnvironment(profile), (args) => {
        assert.deepEqual(args, ["env", profile, "--format", "json"]);
        const endpoint =
          profile === "gateway-one"
            ? "https://gateway-one.example.test"
            : profile === "gateway-two"
              ? "https://gateway-two.example.test/v1?tenant=research"
              : "https://api.anthropic.com";
        return {
          stdout: JSON.stringify({
            AIX_PROFILE: profile,
            ANTHROPIC_API_KEY: secretSentinel,
            ANTHROPIC_BASE_URL: endpoint,
            OPENAI_API_KEY: secretSentinel,
            OPENAI_BASE_URL: endpoint.endsWith("/v1?tenant=research") ? endpoint : `${endpoint}/v1`,
            LITELLM_API_KEY: secretSentinel,
            LITELLM_BASE_URL: endpoint.endsWith("/v1?tenant=research")
              ? endpoint
              : `${endpoint}/v1`,
          }),
        };
      });

    const first = yield* resolve("gateway-one");
    const second = yield* resolve("gateway-two");
    const native = yield* resolve("native");
    assert.deepEqual(
      [first.endpoint, first.endpointKind, second.endpoint, second.endpointKind],
      [
        "https://gateway-one.example.test",
        "unknown",
        "https://gateway-two.example.test/v1?tenant=research",
        "unknown",
      ],
    );
    assert.equal(native.endpointKind, "anthropic");
    assert.equal(first.apiKey, secretSentinel);
    assert.equal(JSON.stringify([first, second, native]).includes(secretSentinel), true);
    assert.equal("apiKey" in first, true);
  }),
);

it.effect("requires an explicit LiteLLM override for an otherwise unknown endpoint", () =>
  Effect.gen(function* () {
    const result = yield* withAix(
      resolveEnvironment("gateway-one", { endpointKind: "litellm" }),
      () => ({
        stdout: JSON.stringify({
          AIX_PROFILE: "gateway-one",
          ANTHROPIC_API_KEY: secretSentinel,
          ANTHROPIC_BASE_URL: "https://gateway-one.example.test",
          OPENAI_API_KEY: secretSentinel,
          OPENAI_BASE_URL: "https://gateway-one.example.test/v1",
        }),
      }),
    );
    assert.equal(result.endpointKind, "litellm");
  }),
);

it.effect("reports safe errors for missing profiles, OAuth profiles, and invalid endpoints", () =>
  Effect.gen(function* () {
    const missing = yield* Effect.result(
      withAix(resolveEnvironment("missing"), () => ({
        stdout: "",
        stderr: "Profile 'missing' not found",
        code: 2,
      })),
    );
    const oauth = yield* Effect.result(
      withAix(resolveEnvironment("chatgpt"), () => ({
        stdout: "",
        stderr: `ChatGPT OAuth profile has no API key (${secretSentinel})`,
        code: 3,
      })),
    );
    const invalidEndpoint = yield* Effect.result(
      withAix(resolveEnvironment("bad"), () => ({
        stdout: JSON.stringify({
          AIX_PROFILE: "bad",
          ANTHROPIC_API_KEY: secretSentinel,
          ANTHROPIC_BASE_URL: "file:///etc/passwd",
          OPENAI_API_KEY: secretSentinel,
          OPENAI_BASE_URL: "file:///etc/passwd/v1",
        }),
      })),
    );

    assert.equal(Result.isFailure(missing) && missing.failure.reason, "profile-not-found");
    assert.equal(Result.isFailure(oauth) && oauth.failure.reason, "oauth-unsupported");
    assert.equal(
      Result.isFailure(invalidEndpoint) && invalidEndpoint.failure.reason,
      "invalid-endpoint",
    );
    assert.equal(JSON.stringify([missing, oauth, invalidEndpoint]).includes(secretSentinel), false);
  }),
);

it.effect("rejects malformed JSON and schema mismatches without echoing process output", () =>
  Effect.gen(function* () {
    const malformed = yield* Effect.result(
      withAix(listProfiles(), () => ({ stdout: `not-json ${secretSentinel}` })),
    );
    const wrongEnvelope = yield* Effect.result(
      withAix(listProfiles(), () => ({ stdout: JSON.stringify({ data: secretSentinel }) })),
    );
    const badModels = yield* Effect.result(
      withAix(listModels("gateway-one"), () => ({
        stdout: JSON.stringify({
          schema_version: 1,
          command: "models",
          data: { models: [{ id: 4 }] },
        }),
      })),
    );

    assert.equal(Result.isFailure(malformed) && malformed.failure.reason, "invalid-json");
    assert.equal(Result.isFailure(wrongEnvelope) && wrongEnvelope.failure.reason, "invalid-schema");
    assert.equal(Result.isFailure(badModels) && badModels.failure.reason, "invalid-schema");
    assert.equal(
      JSON.stringify([malformed, wrongEnvelope, badModels]).includes(secretSentinel),
      false,
    );
  }),
);

it.effect("distinguishes a missing aix executable and an unavailable gateway", () =>
  Effect.gen(function* () {
    const missingAix = yield* Effect.result(
      listProfiles().pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcessSpawner",
                method: "spawn",
                pathOrDescriptor: "aix",
              }),
            ),
          ),
        ),
      ),
    );
    const gatewayDown = yield* Effect.result(
      withAix(listModels("gateway-one"), () => ({
        stdout: "",
        stderr: `connection refused ${secretSentinel}`,
        code: 5,
      })),
    );

    assert.equal(Result.isFailure(missingAix) && missingAix.failure.reason, "aix-not-found");
    assert.equal(
      Result.isFailure(gatewayDown) && gatewayDown.failure.reason,
      "gateway-unavailable",
    );
    assert.equal(JSON.stringify([missingAix, gatewayDown]).includes(secretSentinel), false);
  }),
);

it.effect("does not decode oversized stderr or leak its secret sentinel", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      withAix(resolveEnvironment("oauth-profile"), () => ({
        stdout: "",
        stderr: `oauth ${secretSentinel}${"x".repeat(65_536)}`,
        code: 3,
      })),
    );

    assert.equal(Result.isFailure(result) && result.failure.reason, "command-failed");
    assert.equal(JSON.stringify(result).includes(secretSentinel), false);
  }),
);

it.effect("kills an aix command that exceeds its timeout", () =>
  Effect.gen(function* () {
    const spawned = yield* Deferred.make<void>();
    let killed = false;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(900_000_402),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.sync(() => (killed = true)),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ).pipe(Effect.tap(() => Deferred.succeed(spawned, undefined))),
    );
    const fiber = yield* listProfiles().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkChild,
    );
    yield* Deferred.await(spawned);
    yield* TestClock.adjust(Duration.seconds(15));
    const result = yield* Effect.result(Fiber.join(fiber));

    assert.equal(Result.isFailure(result) && result.failure.reason, "timeout");
    assert.equal(killed, true);
  }),
);
