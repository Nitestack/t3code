// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ChildProcessSpawner } from "effect/process";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { OpenCodeDriver } from "@t3tools/provider-opencode/server";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import type { OpenCodeSettings } from "@t3tools/provider-opencode/settings";

import * as ServerConfig from "../../config.ts";
import { AixProviderInstanceSync } from "../../aix/ProviderInstanceSync.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAixDriver } from "./OpenCodeAixDriver.ts";

const input = (
  config: Partial<OpenCodeSettings> = {},
  environment: Parameters<typeof OpenCodeDriver.create>[0]["environment"] = [],
) => ({
  instanceId: ProviderInstanceId.make("aix-opencode-work"),
  displayName: "OpenCode",
  enabled: true,
  environment,
  config: { ...OpenCodeDriver.defaultConfig(), ...config },
});

const encoder = new TextEncoder();
const aixApiKey = "sk-t08-aix-profile-key";
const aixOutput = JSON.stringify({
  AIX_PROFILE: "work",
  OPENAI_API_KEY: aixApiKey,
  OPENAI_BASE_URL: "http://127.0.0.1:4000/v1",
});

const aixSpawner = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(900_000_808),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.make(encoder.encode(aixOutput)),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

const makeRuntime = (
  starts: Array<NodeJS.ProcessEnv | undefined>,
): OpenCodeRuntime.OpenCodeRuntime["Service"] =>
  OpenCodeRuntime.OpenCodeRuntime.of({
    startOpenCodeServerProcess: (startInput) =>
      Effect.sync(() => {
        starts.push(startInput.environment);
        return {
          url: "http://127.0.0.1:4096",
          version: "2.2.5",
          isRunning: Effect.succeed(true),
          exitCode: Effect.succeed(0),
        };
      }),
    connectToOpenCodeServer: () => Effect.die("unused"),
    runOpenCodeCommand: () => Effect.die("unused"),
    createOpenCodeSdkClient: () =>
      ({}) as unknown as ReturnType<
        OpenCodeRuntime.OpenCodeRuntime["Service"]["createOpenCodeSdkClient"]
      >,
    loadOpenCodeInventory: () => Effect.die("unused"),
    loadOpenCodeSkills: () => Effect.die("unused"),
  });

const testServices = (runtime: OpenCodeRuntime.OpenCodeRuntime["Service"]) =>
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t08-opencode-driver-" }).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto)),
    ),
    Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, runtime),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, aixSpawner),
    Layer.succeed(
      AixProviderInstanceSync,
      AixProviderInstanceSync.of({
        refresh: () => Effect.void,
        getProfileStatus: () => Effect.succeed({ since: 0, code: "request-503" }),
      }),
    ),
  );

type TestEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | SecureRandom.SecureRandom
  | OpenCodeRuntime.OpenCodeRuntime
  | ServerConfig.ServerConfig;

const run = <A, E>(
  effect: Effect.Effect<A, E, TestEnv | Scope.Scope>,
  runtime: OpenCodeRuntime.OpenCodeRuntime["Service"],
) => Effect.scoped(effect.pipe(Effect.provide(testServices(runtime))));

const unusedRuntime = makeRuntime([]);

it.effect("marks aix OpenCode snapshots stale after a failed catalog refresh", () =>
  run(
    Effect.gen(function* () {
      const provider = { status: "ready", message: undefined } as never;
      const snapshot = {
        resolveMaintenance: () => Effect.succeed({} as never),
        getSnapshot: Effect.succeed(provider),
        refresh: Effect.succeed(provider),
        streamChanges: Stream.make(provider),
        applyUsageLimits: () => Effect.void,
      } as ProviderInstance["snapshot"];
      const instance = {
        snapshot,
      } as ProviderInstance;
      const driver = makeOpenCodeAixDriver(() => Effect.succeed(instance));

      const aixInstance = yield* driver.create(
        input({ aixProfile: "work" }, [
          { name: "T3_AIX_PROFILE", value: "work", sensitive: false },
        ]),
      );
      const current = yield* aixInstance.snapshot.getSnapshot;
      const streamed = yield* aixInstance.snapshot.streamChanges.pipe(Stream.runHead);

      expect(current).toMatchObject({
        status: "warning",
        message: "aix catalog stale since 1970-01-01T00:00:00.000Z (request-503).",
      });
      expect(Option.getOrThrow(streamed)).toMatchObject({
        status: "warning",
        message: "aix catalog stale since 1970-01-01T00:00:00.000Z (request-503).",
      });
    }),
    unusedRuntime,
  ),
);

it.effect("keeps an OpenCode instance without the aix marker on the manual path", () =>
  run(
    Effect.gen(function* () {
      let delegated = false;
      const driver = makeOpenCodeAixDriver(() =>
        Effect.gen(function* () {
          delegated = true;
          return yield* new ProviderDriverError({
            driver: OpenCodeDriver.driverKind,
            instanceId: ProviderInstanceId.make("aix-opencode-work"),
            detail: "manual delegate reached",
          });
        }),
      );
      const failure = yield* Effect.flip(
        driver.create(input({}, [{ name: "T3_AIX_PROFILE", value: "work", sensitive: false }])),
      );

      expect(delegated).toBe(true);
      expect(failure.message).toContain("manual delegate reached");
    }),
    unusedRuntime,
  ),
);

it.effect("returns an actionable error for a missing or mismatched aix profile", () =>
  run(
    Effect.gen(function* () {
      const driver = makeOpenCodeAixDriver(() =>
        Effect.fail(
          new ProviderDriverError({
            driver: OpenCodeDriver.driverKind,
            instanceId: ProviderInstanceId.make("aix-opencode-work"),
            detail: "unexpected base create",
          }),
        ),
      );
      const failure = yield* Effect.flip(
        driver.create(
          input({ aixProfile: "work" }, [
            { name: "T3_AIX_PROFILE", value: "home", sensitive: false },
          ]),
        ),
      );

      expect(failure.message).toContain("T3_AIX_PROFILE must match the aixProfile marker");
      expect(failure.message).toContain("aix profiles --json");
    }),
    unusedRuntime,
  ),
);

it.effect("rejects a configured Server URL for an aix profile", () =>
  run(
    Effect.gen(function* () {
      const driver = makeOpenCodeAixDriver(() =>
        Effect.fail(
          new ProviderDriverError({
            driver: OpenCodeDriver.driverKind,
            instanceId: ProviderInstanceId.make("aix-opencode-work"),
            detail: "unexpected base create",
          }),
        ),
      );
      const failure = yield* Effect.flip(
        driver.create(
          input({ aixProfile: "work", serverUrl: "http://127.0.0.1:4096" }, [
            { name: "T3_AIX_PROFILE", value: "work", sensitive: false },
          ]),
        ),
      );

      expect(failure.message).toContain("clear the configured Server URL");
    }),
    unusedRuntime,
  ),
);

it.effect("passes the aix profile's isolated runtime to OpenCode create", () =>
  Effect.gen(function* () {
    const starts: Array<NodeJS.ProcessEnv | undefined> = [];
    const driver = makeOpenCodeAixDriver(() =>
      Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
        yield* runtime
          .startOpenCodeServerProcess({
            binaryPath: "opencode",
            directory: "/work",
          })
          .pipe(
            Effect.mapError(
              () =>
                new ProviderDriverError({
                  driver: OpenCodeDriver.driverKind,
                  instanceId: ProviderInstanceId.make("aix-opencode-work"),
                  detail: "isolated runtime failed",
                }),
            ),
          );
        return yield* new ProviderDriverError({
          driver: OpenCodeDriver.driverKind,
          instanceId: ProviderInstanceId.make("aix-opencode-work"),
          detail: "isolated runtime reached",
        });
      }),
    );
    const failure = yield* Effect.flip(
      driver.create(
        input(
          { aixProfile: "work", customModels: [{ slug: "t3_aix/qwen3-coder", name: "Qwen" }] },
          [{ name: "T3_AIX_PROFILE", value: "work", sensitive: false }],
        ),
      ),
    ).pipe(Effect.provide(testServices(makeRuntime(starts))));
    const environment = starts[0];

    expect(failure.message).toContain("isolated runtime reached");
    expect(environment?.T3_AIX_API_KEY).toBe(aixApiKey);
    expect(environment?.XDG_DATA_HOME).toContain("/providers/opencode/aix/work/data");
    expect(environment?.OPENCODE_CONFIG_CONTENT).toContain("http://127.0.0.1:4000/v1");
    expect(environment?.OPENCODE_CONFIG_CONTENT).toContain('"qwen3-coder"');
    expect(environment?.OPENCODE_CONFIG_CONTENT).not.toContain(aixApiKey);
  }).pipe(Effect.scoped),
);
