import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceConfig } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeProviderInstanceEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

const aixSecret = "fake-aix-api-key-sentinel";
const encode = (value: string) => new TextEncoder().encode(value);
const encodeProviderInstanceConfig = Schema.encodeSync(ProviderInstanceConfig);

const withAixProfiles = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
  profiles: Readonly<Record<string, { readonly endpoint: string; readonly apiKey: string }>>,
) =>
  effect.pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const args = (command as unknown as { readonly args: ReadonlyArray<string> }).args;
        const profile = args[1];
        const response = profiles[profile ?? ""];
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(900_000_411),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(response ? 0 : 1)),
            isRunning: Effect.succeed(false),
            kill: () =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "ChildProcessSpawner",
                  method: "kill",
                  pathOrDescriptor: "aix",
                }),
              ),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(
              encode(
                JSON.stringify({
                  AIX_PROFILE: profile,
                  ANTHROPIC_BASE_URL: response?.endpoint,
                  ANTHROPIC_API_KEY: response?.apiKey,
                  OPENAI_API_KEY: response?.apiKey,
                }),
              ),
            ),
            stderr: Stream.make(encode("")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    ),
  );

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  it.effect(
    "drops the launching Claude session and Electron's run-as-Node flag, and labels processes t3-code unless overridden",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
        const host = {
          CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "host-session",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/host-claude.sock",
          CLAUDE_EFFORT: "high",
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "1",
        };
        const instance = [
          { name: "CLAUDE_CODE_ENTRYPOINT", value: "instance", sensitive: false },
          { name: "CLAUDE_EFFORT", value: "low", sensitive: false },
        ];

        expect(yield* mergeClaudeProcessEnvironment({ homePath }, undefined, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "t3-code",
          KEEP: "1",
        });
        expect(yield* mergeClaudeProcessEnvironment({ homePath }, instance, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "instance",
          CLAUDE_EFFORT: "low",
          KEEP: "1",
        });

        yield* fileSystem.writeFileString(
          path.join(homePath, "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: "custom" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("custom");
      }),
  );

  it.effect("resolves profile references into isolated native Anthropic launch environments", () =>
    Effect.gen(function* () {
      const profileReference = (profileName: string) => [
        { name: "T3_AIX_PROFILE", value: profileName, sensitive: false },
      ];
      const profiles = {
        work: { endpoint: "https://api.anthropic.com", apiKey: `${aixSecret}-work` },
        personal: { endpoint: "https://api.anthropic.com", apiKey: `${aixSecret}-personal` },
      };
      const work = yield* withAixProfiles(
        resolveClaudeProviderInstanceEnvironment(profileReference("work")),
        profiles,
      );
      const personal = yield* withAixProfiles(
        resolveClaudeProviderInstanceEnvironment(profileReference("personal")),
        profiles,
      );
      const hostEnvironment = {
        KEEP: "host-value",
        ANTHROPIC_AUTH_TOKEN: "stale-host-token",
        ANTHROPIC_API_KEY: "stale-host-key",
      };
      const workProcessEnvironment = yield* mergeClaudeProcessEnvironment(
        { homePath: "" },
        work,
        hostEnvironment,
      );
      const personalProcessEnvironment = yield* mergeClaudeProcessEnvironment(
        { homePath: "" },
        personal,
        hostEnvironment,
      );

      expect(work).toEqual([
        { name: "ANTHROPIC_BASE_URL", value: "https://api.anthropic.com", sensitive: false },
        { name: "ANTHROPIC_API_KEY", value: `${aixSecret}-work`, sensitive: true },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: false },
      ]);
      expect(personal).toEqual([
        { name: "ANTHROPIC_BASE_URL", value: "https://api.anthropic.com", sensitive: false },
        { name: "ANTHROPIC_API_KEY", value: `${aixSecret}-personal`, sensitive: true },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: false },
      ]);
      expect(work.some(({ name }) => name === "T3_AIX_PROFILE")).toBe(false);
      expect(workProcessEnvironment).toMatchObject({
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: `${aixSecret}-work`,
        ANTHROPIC_AUTH_TOKEN: "",
      });
      expect(personalProcessEnvironment.ANTHROPIC_API_KEY).toBe(`${aixSecret}-personal`);
      expect(personalProcessEnvironment.ANTHROPIC_AUTH_TOKEN).toBe("");
      expect(workProcessEnvironment).not.toBe(hostEnvironment);
      expect(hostEnvironment).toEqual({
        KEEP: "host-value",
        ANTHROPIC_AUTH_TOKEN: "stale-host-token",
        ANTHROPIC_API_KEY: "stale-host-key",
      });
    }),
  );

  it.effect("resolves a rotated profile credential again for a later Claude process", () =>
    Effect.gen(function* () {
      const profiles: Record<string, { endpoint: string; apiKey: string }> = {
        work: { endpoint: "https://api.anthropic.com", apiKey: `${aixSecret}-before-refresh` },
      };
      const reference = [{ name: "T3_AIX_PROFILE", value: "work", sensitive: false }];
      const first = yield* withAixProfiles(
        resolveClaudeProviderInstanceEnvironment(reference),
        profiles,
      );
      profiles.work = {
        endpoint: "https://api.anthropic.com",
        apiKey: `${aixSecret}-after-refresh`,
      };
      const nextTurn = yield* withAixProfiles(
        resolveClaudeProviderInstanceEnvironment(reference),
        profiles,
      );

      expect(first.find(({ name }) => name === "ANTHROPIC_API_KEY")?.value).toBe(
        `${aixSecret}-before-refresh`,
      );
      expect(nextTurn.find(({ name }) => name === "ANTHROPIC_API_KEY")?.value).toBe(
        `${aixSecret}-after-refresh`,
      );
    }),
  );

  it.effect("uses bearer auth for an explicitly selected Claude aix gateway", () =>
    Effect.gen(function* () {
      const profileReference = (profileName: string) => [
        { name: "T3_AIX_PROFILE", value: profileName, sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "stale-instance-token", sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "stale-instance-key", sensitive: true },
      ];
      const [gatewayA, gatewayB] = yield* withAixProfiles(
        Effect.all([
          resolveClaudeProviderInstanceEnvironment(profileReference("gateway-a")),
          resolveClaudeProviderInstanceEnvironment(profileReference("gateway-b")),
        ]),
        {
          "gateway-a": { endpoint: "https://gateway-a.example.test", apiKey: `${aixSecret}-a` },
          "gateway-b": { endpoint: "https://gateway-b.example.test", apiKey: `${aixSecret}-b` },
        },
      );

      expect(gatewayA).toEqual([
        { name: "ANTHROPIC_BASE_URL", value: "https://gateway-a.example.test", sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: `${aixSecret}-a`, sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ]);
      expect(gatewayB).toEqual([
        { name: "ANTHROPIC_BASE_URL", value: "https://gateway-b.example.test", sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: `${aixSecret}-b`, sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ]);

      const hostEnvironment = {
        ANTHROPIC_AUTH_TOKEN: "stale-host-token",
        ANTHROPIC_API_KEY: "stale-host-key",
        KEEP: "host-value",
      };
      const launchEnvironmentA = yield* mergeClaudeProcessEnvironment(
        { homePath: "" },
        gatewayA,
        hostEnvironment,
      );
      const launchEnvironmentB = yield* mergeClaudeProcessEnvironment(
        { homePath: "" },
        gatewayB,
        hostEnvironment,
      );
      expect(launchEnvironmentA).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: `${aixSecret}-a`,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_BASE_URL: "https://gateway-a.example.test",
        KEEP: "host-value",
      });
      expect(launchEnvironmentB).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: `${aixSecret}-b`,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_BASE_URL: "https://gateway-b.example.test",
        KEEP: "host-value",
      });
      expect(JSON.stringify(launchEnvironmentA)).not.toContain("stale-host-token");
      expect(JSON.stringify(launchEnvironmentA)).not.toContain("stale-host-key");
      expect(launchEnvironmentA.ANTHROPIC_AUTH_TOKEN).not.toBe(
        launchEnvironmentB.ANTHROPIC_AUTH_TOKEN,
      );
      expect(hostEnvironment).toEqual({
        ANTHROPIC_AUTH_TOKEN: "stale-host-token",
        ANTHROPIC_API_KEY: "stale-host-key",
        KEEP: "host-value",
      });
    }),
  );

  it.effect(
    "rejects secret-valued or ambiguous profile references without leaking their values",
    () =>
      Effect.gen(function* () {
        const secretValue = `${aixSecret}-profile`;
        const result = yield* Effect.result(
          resolveClaudeProviderInstanceEnvironment([
            { name: "T3_AIX_PROFILE", value: secretValue, sensitive: true },
            { name: "T3_AIX_PROFILE", value: "other", sensitive: false },
          ]),
        );

        expect(result._tag).toBe("Failure");
        expect(JSON.stringify(result)).not.toContain(secretValue);
      }),
  );

  it.effect("serializes only the profile reference, never the resolved API key", () =>
    Effect.sync(() => {
      const encoded = encodeProviderInstanceConfig({
        driver: ProviderDriverKind.make("claudeAgent"),
        environment: [{ name: "T3_AIX_PROFILE", value: "work", sensitive: false }],
      });

      expect(encoded.environment?.[0]?.value).toBe("work");
      expect(JSON.stringify(encoded)).not.toContain(aixSecret);
    }),
  );
});
