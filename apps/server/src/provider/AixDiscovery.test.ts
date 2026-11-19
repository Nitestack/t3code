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
import {
  AixDiscoveryError,
  listCatalog,
  listModels,
  listProfiles,
  readBudget,
  resolveEnvironment,
} from "./AixDiscovery.ts";

const secretSentinel = "aix-secret-sentinel-do-not-leak";
const encoder = new TextEncoder();

type CommandResult = {
  readonly stdout: string;
  readonly stderr?: string | ReadonlyArray<Uint8Array>;
  readonly code?: number;
};

function mockHandle(result: CommandResult, onKill: () => void = () => undefined) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_401),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.sync(onKill),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr:
      typeof result.stderr === "string" || result.stderr === undefined
        ? Stream.make(encoder.encode(result.stderr ?? ""))
        : Stream.fromIterable(result.stderr),
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
    assert.deepEqual(args.slice(0, 2), ["--error-format", "json"]);
    return Effect.succeed(mockHandle(handler(args.slice(2))));
  });
  return effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
}

/** What `aix --error-format json` writes to stderr; messages may echo secrets. */
const aixError = (code: string, category: string) =>
  JSON.stringify({
    schema_version: 1,
    command: "env",
    error: { code, category, exit_code: 2, message: `failed with ${secretSentinel}` },
  });

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

it.effect("classifies an otherwise unknown endpoint by the gateway kind aix reports", () =>
  Effect.gen(function* () {
    const kind = (gatewayKind: string) =>
      withAix(resolveEnvironment("gateway-one"), () => ({
        stdout: JSON.stringify({
          AIX_PROFILE: "gateway-one",
          AIX_GATEWAY_KIND: gatewayKind,
          ANTHROPIC_API_KEY: secretSentinel,
          ANTHROPIC_BASE_URL: "https://gateway-one.example.test",
          OPENAI_API_KEY: secretSentinel,
          OPENAI_BASE_URL: "https://gateway-one.example.test/v1",
        }),
      })).pipe(Effect.map((result) => result.endpointKind));
    assert.deepEqual(
      [yield* kind("litellm"), yield* kind("anthropic"), yield* kind("aihub")],
      ["litellm", "anthropic", "unknown"],
    );
  }),
);

it.effect("reports safe errors for missing profiles, OAuth profiles, and invalid endpoints", () =>
  Effect.gen(function* () {
    const missing = yield* Effect.result(
      withAix(resolveEnvironment("missing"), () => ({
        stdout: "",
        stderr: aixError("profile_not_found", "config"),
        code: 2,
      })),
    );
    const oauth = yield* Effect.result(
      withAix(resolveEnvironment("chatgpt"), () => ({
        stdout: "",
        stderr: aixError("chatgpt_unsupported", "config"),
        code: 2,
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
        stderr: aixError("gateway_unreachable", "network"),
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

it.effect("reads the budget from aix spend and classifies failures by error code", () =>
  Effect.gen(function* () {
    const calls: Array<ReadonlyArray<string>> = [];
    const budget = yield* withAix(readBudget("ac"), (args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          schema_version: 1,
          command: "spend",
          data: {
            spend: 159.03,
            max_budget: 175,
            status: "available",
            key_spent_usd: 159.03,
            remaining_usd: 15.96,
            limited_by: "key",
            layers: [
              {
                scope: "key",
                budget_usd: 175,
                spent_usd: 159.03,
                remaining_usd: 15.96,
                period_start: "2026-11-01T00:00:00Z",
                resets_at: "2026-12-01T00:00:00Z",
                budget_duration: "1mo",
                reset_source: "inferred_monthly",
              },
            ],
            expires_at: null,
            project_id: "project-1",
            cache: { source: "cache", age_seconds: 12, fetched_at: "2026-11-19T14:29:40Z" },
            profile: { name: "ac", label: "adCare" },
            key_fingerprint: "f".repeat(64),
            gateway: { gateway: "aihub", provider: null, detected_from: "response" },
          },
        }),
      };
    });
    assert.deepEqual(calls, [
      ["--json", "--non-interactive", "--timeout", "20s", "spend", "ac", "--max-age", "60s"],
    ]);
    assert.deepEqual(budget.layers?.[0]?.resets_at, "2026-12-01T00:00:00Z");
    assert.deepEqual(
      [budget.project_id, budget.key_fingerprint, budget.gateway.gateway],
      ["project-1", "f".repeat(64), "aihub"],
    );

    const failure = (code: string, category: string) =>
      withAix(readBudget("ac"), () => ({
        stdout: "",
        stderr: aixError(code, category),
        code: 4,
      })).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
    const reasons = yield* Effect.all([
      failure("gateway_auth_failed", "authentication"),
      failure("gateway_unreachable", "network"),
      failure("gateway_timeout", "network"),
      failure("internal", "internal"),
    ]);
    assert.deepEqual(reasons, [
      "gateway-rejected",
      "gateway-unavailable",
      "timeout",
      "command-failed",
    ]);
    const unstructured = yield* withAix(readBudget("ac"), () => ({
      stdout: "",
      stderr: `profile not found ${secretSentinel}`,
      code: 2,
    })).pipe(Effect.flip);
    assert.equal(unstructured.reason, "command-failed");
  }),
);

it.effect("reads the detailed catalog through aix and rejects one without model info", () =>
  Effect.gen(function* () {
    const model = {
      id: "claude-opus-5-5",
      route: "claude-opus-5-5*",
      mode: "chat",
      provider: "google",
      display_name: null,
      deployments: 1,
      context_tokens: 1000000,
      max_output_tokens: 128000,
      capabilities: {},
      reasoning: { efforts: ["low", "max"], default_effort: null },
      pricing: {
        input_per_million: 5,
        output_per_million: 25,
        cache_read_per_million: 0.5,
        cache_write_per_million: 6.25,
      },
    };
    const calls: Array<ReadonlyArray<string>> = [];
    const catalog = (refresh: boolean, modelInfo = true) =>
      withAix(listCatalog("ac", refresh), (args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({
            schema_version: 1,
            command: "models",
            data: {
              models: [model],
              filter: null,
              wildcard_routes: [],
              sources: { model_info: modelInfo, model_group_info: false },
              cache: { source: "live", age_seconds: null, fetched_at: "2026-11-19T17:04:07Z" },
            },
          }),
        };
      });
    const models = yield* catalog(false);
    yield* catalog(true);
    assert.deepEqual(calls, [
      [
        "--json",
        "--non-interactive",
        "--timeout",
        "20s",
        "models",
        "ac",
        "--detailed",
        "--max-age",
        "1h",
      ],
      [
        "--json",
        "--non-interactive",
        "--timeout",
        "20s",
        "models",
        "ac",
        "--detailed",
        "--refresh",
      ],
    ]);
    assert.deepEqual(
      models.map(({ id, pricing }) => [id, pricing?.input_per_million]),
      [["claude-opus-5-5", 5]],
    );
    const idsOnly = yield* catalog(false, false).pipe(Effect.flip);
    assert.equal(idsOnly.reason, "catalog-unsupported");
  }),
);

it.effect("does not decode oversized single or fragmented stderr or leak its secret sentinel", () =>
  Effect.gen(function* () {
    const stderr = `oauth ${secretSentinel}${"x".repeat(65_536)}`;
    const bytes = encoder.encode(stderr);
    const fragments = Array.from(bytes, (byte) => new Uint8Array([byte]));
    for (const output of [stderr, fragments]) {
      const result = yield* Effect.result(
        withAix(resolveEnvironment("oauth-profile"), () => ({
          stdout: "",
          stderr: output,
          code: 3,
        })),
      );

      assert.equal(Result.isFailure(result) && result.failure.reason, "command-failed");
      assert.equal(JSON.stringify(result).includes(secretSentinel), false);
    }
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
