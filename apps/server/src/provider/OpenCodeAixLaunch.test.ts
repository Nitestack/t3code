import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { describe, expect, it as plainIt } from "vite-plus/test";

import * as OpenCodeRuntimeModule from "@t3tools/provider-opencode/server/OpenCodeRuntime";

import {
  OPENCODE_AIX_PROVIDER_ID,
  openCodeAixConfigContent,
  openCodeAixProfileReference,
  resolveOpenCodeAixEnvironment,
  withOpenCodeAixRuntime,
} from "./OpenCodeAixLaunch.ts";

const sentinelA = "sk-t08-sentinel-profile-a";
const sentinelB = "sk-t08-sentinel-profile-b";
const inheritedEnvironment = process.env;
const models = [
  { id: "google/gemma-4-31b-it", name: "Gemma 4 31B IT" },
  { id: "gpt-oss-120b", name: "GPT-OSS 120B" },
];
const encoder = new TextEncoder();

type Services =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | Scope.Scope;

const mockOutput = (stdout: string, code = 0, stderr = "") =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_808),
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

// Fakes only the `aix env <profile>` call; the profile name is argv[1].
const fakeAix = (
  respond: (profile: string) => { stdout: string; code?: number; stderr?: string },
) =>
  ChildProcessSpawner.make((command) => {
    const args = (command as unknown as { readonly args: ReadonlyArray<string> }).args;
    const result = respond(args[1] ?? "");
    return Effect.succeed(mockOutput(result.stdout, result.code, result.stderr));
  });

const litellmEnv = (profile: string, apiKey: string, endpoint: string) =>
  JSON.stringify({
    AIX_PROFILE: profile,
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: `${endpoint}/v1`,
  });

// Profile "home" has its own key and gateway, so mixing either would be visible.
const twoProfiles = fakeAix((profile) =>
  profile === "home"
    ? { stdout: litellmEnv("home", sentinelB, "http://127.0.0.1:4001") }
    : { stdout: litellmEnv("work", sentinelA, "http://127.0.0.1:4000") },
);

const run = <A, E>(
  effect: Effect.Effect<A, E, Services>,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"] = twoProfiles,
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto)),
    ),
  );

const stateDirEffect = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t08-opencode-aix-" });
});

describe("openCodeAixConfigContent", () => {
  plainIt(
    "pins the profile provider, keeps upstream model ids, and holds the key only as an env reference",
    () => {
      const content = openCodeAixConfigContent({ baseURL: "http://127.0.0.1:4000/v1", models });
      const config = JSON.parse(content) as {
        enabled_providers: ReadonlyArray<string>;
        provider: Record<
          string,
          { options: { baseURL: string; apiKey: string }; models: Record<string, unknown> }
        >;
      };
      const provider = config.provider[OPENCODE_AIX_PROVIDER_ID];

      expect(config.enabled_providers).toEqual([OPENCODE_AIX_PROVIDER_ID]);
      expect(provider?.options).toEqual({
        baseURL: "http://127.0.0.1:4000/v1",
        apiKey: "{env:T3_AIX_API_KEY}",
      });
      expect(Object.keys(provider?.models ?? {})).toEqual([
        "google/gemma-4-31b-it",
        "gpt-oss-120b",
      ]);
      expect(content).not.toContain(sentinelA);
    },
  );
});

describe("openCodeAixProfileReference", () => {
  plainIt("requires the settings marker and a matching non-secret profile reference", () => {
    const environment = [{ name: "T3_AIX_PROFILE", value: "work", sensitive: false }];
    expect(openCodeAixProfileReference({ environment })).toEqual({ _tag: "manual" });
    expect(openCodeAixProfileReference({ aixProfile: "work", environment })).toEqual({
      _tag: "aix",
      profile: "work",
    });
    expect(
      openCodeAixProfileReference({
        aixProfile: "home",
        environment,
      }),
    ).toEqual({ _tag: "invalid" });
  });
});

describe("resolveOpenCodeAixEnvironment", () => {
  it.effect("gives two profiles their own key, config, and state roots", () =>
    run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const stateDir = yield* stateDirEffect;
        const { work, home } = yield* Effect.all(
          {
            work: resolveOpenCodeAixEnvironment({
              profileName: "work",
              models,
              environment: { PATH: "/usr/bin" },
              stateDir,
            }),
            home: resolveOpenCodeAixEnvironment({
              profileName: "home",
              models,
              environment: { PATH: "/usr/bin" },
              stateDir,
            }),
          },
          { concurrency: "unbounded" },
        );

        expect(work.environment.T3_AIX_API_KEY).toBe(sentinelA);
        expect(home.environment.T3_AIX_API_KEY).toBe(sentinelB);
        expect(work.environment.XDG_DATA_HOME).toBe(
          path.join(stateDir, "providers", "opencode", "aix", "work", "data"),
        );
        expect(work.environment.XDG_DATA_HOME).not.toBe(home.environment.XDG_DATA_HOME);
        expect(work.environment.OPENCODE_CONFIG_CONTENT).toContain("http://127.0.0.1:4000/v1");
        expect(home.environment.OPENCODE_CONFIG_CONTENT).toContain("http://127.0.0.1:4001/v1");
        expect(work.environment.OPENCODE_CONFIG_CONTENT).not.toContain(sentinelB);
        expect(home.environment.OPENCODE_CONFIG_CONTENT).not.toContain(sentinelA);
        expect(work.environment.PATH).toBe("/usr/bin");
      }),
    ),
  );

  it.effect("removes host credentials and the profile reference from the child environment", () =>
    run(
      Effect.gen(function* () {
        const stateDir = yield* stateDirEffect;
        const resolved = yield* resolveOpenCodeAixEnvironment({
          profileName: "work",
          models,
          environment: {
            T3_AIX_PROFILE: "work",
            OPENAI_API_KEY: "host-openai",
            OPENAI_BASE_URL: "https://host-gateway.invalid/v1",
            LITELLM_API_KEY: "host-litellm",
            LITELLM_BASE_URL: "https://host-litellm.invalid/v1",
            ANTHROPIC_API_KEY: "host-anthropic",
            ANTHROPIC_BASE_URL: "https://host-anthropic.invalid/v1",
            GOOGLE_API_KEY: "host-google",
            OPENROUTER_API_KEY: "host-openrouter",
            OPENCODE_API_KEY: "host-opencode",
            OPENCODE_AUTH_CONTENT: "{}",
            OPENCODE_CONFIG: "/home/user/opencode.json",
            OPENCODE_CONFIG_DIR: "/home/user/.config/opencode",
            OPENCODE_DB: "/home/user/.local/share/opencode/opencode.db",
          },
          stateDir,
        });

        for (const name of [
          "T3_AIX_PROFILE",
          "OPENAI_API_KEY",
          "OPENAI_BASE_URL",
          "LITELLM_API_KEY",
          "LITELLM_BASE_URL",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_BASE_URL",
          "GOOGLE_API_KEY",
          "OPENROUTER_API_KEY",
          "OPENCODE_API_KEY",
          "OPENCODE_AUTH_CONTENT",
          "OPENCODE_CONFIG",
          "OPENCODE_CONFIG_DIR",
          "OPENCODE_DB",
        ]) {
          expect(resolved.environment[name]).toBeUndefined();
        }
      }),
    ),
  );

  it.effect("fails explicitly for each unusable profile instead of substituting one", () =>
    run(
      Effect.gen(function* () {
        const stateDir = yield* stateDirEffect;
        const reasonOf = (
          profileName: string,
          spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
          environment: NodeJS.ProcessEnv = {},
        ) =>
          resolveOpenCodeAixEnvironment({ profileName, models, environment, stateDir }).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );

        expect(yield* reasonOf("../escape", twoProfiles)).toBe("invalid-profile");
        expect(yield* reasonOf("work", twoProfiles, { OPENCODE_CONFIG_CONTENT: "{}" })).toBe(
          "launch-conflict",
        );
        expect(
          yield* reasonOf(
            "claude",
            fakeAix(() => ({
              stdout: JSON.stringify({
                AIX_PROFILE: "claude",
                ANTHROPIC_API_KEY: sentinelA,
                ANTHROPIC_BASE_URL: "https://api.anthropic.com",
              }),
            })),
          ),
        ).toBe("unsupported-endpoint");
        expect(
          yield* reasonOf(
            "remote",
            fakeAix(() => ({
              stdout: litellmEnv("remote", sentinelA, "http://gateway.example.com"),
            })),
          ),
        ).toBe("insecure-endpoint");
        expect(
          yield* reasonOf(
            "missing",
            fakeAix(() => ({ stdout: "", code: 1, stderr: "profile not found" })),
          ),
        ).toBe("profile-unavailable");
      }),
    ),
  );
});

type RuntimeService = Pick<
  OpenCodeRuntimeModule.OpenCodeRuntime["Service"],
  "startOpenCodeServerProcess" | "connectToOpenCodeServer"
>;
type StartInput = Parameters<RuntimeService["startOpenCodeServerProcess"]>[0];

describe("withOpenCodeAixRuntime", () => {
  it.effect("keeps concurrent profile launches on their own key, config, and data roots", () =>
    run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const stateDir = yield* stateDirEffect;
        const started: Array<StartInput> = [];
        const base: RuntimeService = {
          startOpenCodeServerProcess: (input) =>
            Effect.sync(() => {
              started.push(input);
              return {
                url: "http://127.0.0.1:4096",
                version: "2.2.5",
                isRunning: Effect.succeed(true),
                exitCode: Effect.succeed(0),
              };
            }),
          connectToOpenCodeServer: () => Effect.die("unused"),
        };
        const { work, home } = yield* Effect.all(
          {
            work: withOpenCodeAixRuntime(base, { profileName: "work", models, stateDir }),
            home: withOpenCodeAixRuntime(base, { profileName: "home", models, stateDir }),
          },
          { concurrency: "unbounded" },
        );

        yield* Effect.all(
          [
            work.startOpenCodeServerProcess({
              binaryPath: "opencode",
              directory: "/tmp",
              environment: { PATH: "/usr/bin" },
            }),
            home.startOpenCodeServerProcess({
              binaryPath: "opencode",
              directory: "/tmp",
              environment: { PATH: "/usr/bin" },
            }),
          ],
          { concurrency: "unbounded" },
        );

        const byKey = new Map(
          started.map((input) => [input.environment?.T3_AIX_API_KEY, input.environment]),
        );
        for (const [profile, key, port] of [
          ["work", sentinelA, 4000],
          ["home", sentinelB, 4001],
        ] as const) {
          const environment = byKey.get(key);
          expect(environment).toBeDefined();
          expect(environment?.XDG_DATA_HOME).toBe(
            path.join(stateDir, "providers", "opencode", "aix", profile, "data"),
          );
          expect(environment?.OPENCODE_CONFIG_CONTENT).toContain(`http://127.0.0.1:${port}/v1`);
          expect(environment?.OPENCODE_CONFIG_CONTENT).not.toContain(
            profile === "work" ? sentinelB : sentinelA,
          );
        }
        expect(started).toHaveLength(2);
      }),
    ),
  );

  it.effect("uses the server process environment when the runtime receives no explicit env", () =>
    run(
      Effect.gen(function* () {
        const stateDir = yield* stateDirEffect;
        let captured: StartInput | undefined;
        const base: RuntimeService = {
          startOpenCodeServerProcess: (input) => {
            captured = input;
            return Effect.die("test capture");
          },
          connectToOpenCodeServer: () => Effect.die("unused"),
        };
        const runtime = yield* withOpenCodeAixRuntime(base, {
          profileName: "work",
          models,
          stateDir,
        });
        yield* runtime
          .startOpenCodeServerProcess({ binaryPath: "opencode", directory: "/tmp" })
          .pipe(Effect.exit);

        expect(captured?.environment?.PATH).toBe(inheritedEnvironment.PATH);
        expect(captured?.environment?.HOME).toBe(inheritedEnvironment.HOME);
      }),
    ),
  );

  it.effect(
    "starts the local server with the resolved environment and a password for this start",
    () =>
      run(
        Effect.gen(function* () {
          const stateDir = yield* stateDirEffect;
          const started: Array<StartInput> = [];
          const base: RuntimeService = {
            startOpenCodeServerProcess: (input) => {
              started.push(input);
              return Effect.die("the test stops at the base runtime");
            },
            connectToOpenCodeServer: () => Effect.die("unused"),
          };
          const runtime = yield* withOpenCodeAixRuntime(base, {
            profileName: "work",
            models,
            stateDir,
          });

          yield* runtime
            .startOpenCodeServerProcess({
              binaryPath: "opencode",
              directory: "/tmp",
              environment: { PATH: "/usr/bin" },
            })
            .pipe(Effect.exit);

          const input = started[0];
          expect(input?.environment?.T3_AIX_API_KEY).toBe(sentinelA);
          expect(input?.environment?.OPENCODE_CONFIG_CONTENT).toContain(OPENCODE_AIX_PROVIDER_ID);
          expect(input?.serverPassword).toBeTruthy();
          expect(input?.serverPassword).toBe(input?.environment?.OPENCODE_SERVER_PASSWORD);
        }),
      ),
  );

  it.effect("refuses an external Server URL instead of silently dropping the profile config", () =>
    run(
      Effect.gen(function* () {
        const stateDir = yield* stateDirEffect;
        const base: RuntimeService = {
          startOpenCodeServerProcess: () => Effect.die("unused"),
          connectToOpenCodeServer: () => Effect.die("must not reach the base runtime"),
        };
        const runtime = yield* withOpenCodeAixRuntime(base, {
          profileName: "work",
          models,
          stateDir,
        });
        const error = yield* runtime
          .connectToOpenCodeServer({
            binaryPath: "opencode",
            directory: "/tmp",
            serverUrl: "http://127.0.0.1:4096",
            environment: { PATH: "/usr/bin" },
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(OpenCodeRuntimeModule.OpenCodeRuntimeError);
        expect(error.detail).toContain("Server URL");
      }),
    ),
  );

  it.effect("redacts a key echoed by a failed child launch before returning the error", () =>
    run(
      Effect.gen(function* () {
        const stateDir = yield* stateDirEffect;
        const base: RuntimeService = {
          startOpenCodeServerProcess: () =>
            Effect.fail(
              new OpenCodeRuntimeModule.OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `gateway rejected ${sentinelA}`,
                cause: { output: sentinelA },
              }),
            ),
          connectToOpenCodeServer: () => Effect.die("unused"),
        };
        const runtime = yield* withOpenCodeAixRuntime(base, {
          profileName: "work",
          models,
          stateDir,
        });
        const error = yield* runtime
          .startOpenCodeServerProcess({ binaryPath: "opencode", directory: "/tmp" })
          .pipe(Effect.flip);

        expect(error.detail).not.toContain(sentinelA);
        expect(error.cause).toBeUndefined();
      }),
    ),
  );
});
