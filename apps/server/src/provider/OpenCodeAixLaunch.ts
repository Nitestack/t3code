import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ChildProcessSpawner } from "effect/process";

import * as OpenCodeRuntimeModule from "@t3tools/provider-opencode/server/OpenCodeRuntime";

import * as AixDiscovery from "./AixDiscovery.ts";

export const OPENCODE_AIX_PROVIDER_ID = "t3_aix";

const PROFILE_ENV = "T3_AIX_PROFILE";
const API_KEY_ENV = "T3_AIX_API_KEY";
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** Host variables that would let OpenCode reach personal config, auth, or another provider. */
const HOST_CREDENTIAL_ENV = [
  PROFILE_ENV,
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "LITELLM_API_KEY",
  "LITELLM_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "COHERE_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
] as const;

export class OpenCodeAixLaunchError extends Schema.TaggedError<
  OpenCodeAixLaunchError,
  { readonly brand: unique symbol }
>()("OpenCodeAixLaunchError", {
  reason: Schema.Literals([
    "invalid-profile",
    "profile-unavailable",
    "unsupported-endpoint",
    "launch-conflict",
    "insecure-endpoint",
    "state-unavailable",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-profile":
        return "The aix profile name is not a valid OpenCode profile reference.";
      case "profile-unavailable":
        return "The aix profile could not be resolved. Check that `aix env <profile>` works on this host.";
      case "unsupported-endpoint":
        return "OpenCode aix profiles need an OpenAI-compatible gateway; native Anthropic profiles are not supported here.";
      case "launch-conflict":
        return "OpenCode aix profiles cannot be combined with a native OPENCODE_CONFIG_CONTENT override.";
      case "insecure-endpoint":
        return "OpenCode aix gateway authentication requires HTTPS outside loopback.";
      case "state-unavailable":
        return "The OpenCode aix state directory could not be created.";
    }
  }
}

/** The settings marker owns aix behavior; an environment variable alone never opts a manual instance in. */
export type OpenCodeAixProfileReference =
  | { readonly _tag: "manual" }
  | { readonly _tag: "aix"; readonly profile: string }
  | { readonly _tag: "invalid" };

export const openCodeAixProfileReference = (input: {
  readonly aixProfile?: string | undefined;
  readonly environment: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly sensitive: boolean;
  }>;
}): OpenCodeAixProfileReference => {
  if (input.aixProfile === undefined) return { _tag: "manual" };
  const profiles = input.environment.filter(({ name }) => name === PROFILE_ENV);
  const profile = profiles[0];
  if (
    profiles.length !== 1 ||
    profile === undefined ||
    profile.sensitive ||
    profile.value.trim().length === 0 ||
    profile.value !== profile.value.trim() ||
    profile.value !== input.aixProfile
  ) {
    return { _tag: "invalid" };
  }
  return { _tag: "aix", profile: profile.value };
};

export interface OpenCodeAixModel {
  readonly id: string;
  readonly name: string;
}

export interface OpenCodeAixRuntimeInput {
  readonly profileName: string;
  readonly models: ReadonlyArray<OpenCodeAixModel>;
  readonly stateDir: string;
}

const openAiBaseUrl = (endpoint: string): string => {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/(?:\/v1)+\/?$/u, "").replace(/\/$/u, "") + "/v1";
  return url.toString().replace(/\/$/u, "");
};

/** The key is referenced, never inlined, so the config is safe to log and to hand to the child. */
export function openCodeAixConfigContent(input: {
  readonly baseURL: string;
  readonly models: ReadonlyArray<OpenCodeAixModel>;
}): string {
  return JSON.stringify({
    enabled_providers: [OPENCODE_AIX_PROVIDER_ID],
    provider: {
      [OPENCODE_AIX_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "aix",
        options: { baseURL: input.baseURL, apiKey: `{env:${API_KEY_ENV}}` },
        models: Object.fromEntries(input.models.map((model) => [model.id, { name: model.name }])),
      },
    },
  });
}

/** Resolves one profile's gateway for one OpenCode server start. Fails instead of substituting. */
export const resolveOpenCodeAixEnvironment = Effect.fn("OpenCodeAixLaunch.resolveEnvironment")(
  function* (input: {
    readonly profileName: string;
    readonly models: ReadonlyArray<OpenCodeAixModel>;
    readonly environment: NodeJS.ProcessEnv;
    readonly stateDir: string;
  }): Effect.fn.Return<
    { readonly environment: NodeJS.ProcessEnv },
    OpenCodeAixLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    if (!PROFILE_NAME.test(input.profileName)) {
      return yield* new OpenCodeAixLaunchError({ reason: "invalid-profile" });
    }
    if (input.environment.OPENCODE_CONFIG_CONTENT !== undefined) {
      return yield* new OpenCodeAixLaunchError({ reason: "launch-conflict" });
    }

    const resolved = yield* AixDiscovery.resolveEnvironment(input.profileName).pipe(
      Effect.mapError(() => new OpenCodeAixLaunchError({ reason: "profile-unavailable" })),
    );
    if (resolved.endpointKind === "anthropic") {
      return yield* new OpenCodeAixLaunchError({ reason: "unsupported-endpoint" });
    }
    const endpoint = new URL(resolved.endpoint);
    if (
      endpoint.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    ) {
      return yield* new OpenCodeAixLaunchError({ reason: "insecure-endpoint" });
    }

    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const profileRoot = path.join(
      input.stateDir,
      "providers",
      "opencode",
      "aix",
      input.profileName,
    );
    yield* fileSystem
      .makeDirectory(profileRoot, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(() => new OpenCodeAixLaunchError({ reason: "state-unavailable" })));

    const environment: NodeJS.ProcessEnv = { ...input.environment };
    for (const name of HOST_CREDENTIAL_ENV) delete environment[name];
    environment[API_KEY_ENV] = resolved.apiKey;
    environment.OPENCODE_CONFIG_CONTENT = openCodeAixConfigContent({
      baseURL: openAiBaseUrl(resolved.endpoint),
      models: input.models,
    });
    environment.XDG_CONFIG_HOME = path.join(profileRoot, "config");
    environment.XDG_DATA_HOME = path.join(profileRoot, "data");
    environment.XDG_STATE_HOME = path.join(profileRoot, "state");
    environment.XDG_CACHE_HOME = path.join(profileRoot, "cache");
    return { environment };
  },
);

type OpenCodeRuntimeService = Pick<
  OpenCodeRuntimeModule.OpenCodeRuntime["Service"],
  "startOpenCodeServerProcess" | "connectToOpenCodeServer"
>;

/**
 * Wraps the OpenCode runtime so each server start gets the profile's environment. The aix call and
 * the key stay in the child environment; nothing is stored in settings or sent to clients.
 */
export const withOpenCodeAixRuntime = Effect.fn("OpenCodeAixLaunch.withRuntime")(function* (
  base: OpenCodeRuntimeService,
  input: OpenCodeAixRuntimeInput,
): Effect.fn.Return<
  OpenCodeRuntimeService,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | SecureRandom.SecureRandom
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const startOpenCodeServerProcess: OpenCodeRuntimeService["startOpenCodeServerProcess"] =
    Effect.fn("OpenCodeAixLaunch.startOpenCodeServerProcess")(function* (startInput) {
      const resolved = yield* resolveOpenCodeAixEnvironment({
        profileName: input.profileName,
        models: input.models,
        environment: startInput.environment ?? {},
        stateDir: input.stateDir,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (error) =>
            new OpenCodeRuntimeModule.OpenCodeRuntimeError({
              operation: "startOpenCodeServerProcess",
              detail: error.message,
              cause: error,
            }),
        ),
      );
      const serverPassword =
        startInput.serverPassword ??
        Buffer.from(yield* random.randomBytes(32)).toString("base64url");
      return yield* base
        .startOpenCodeServerProcess({
          ...startInput,
          serverPassword,
          environment: { ...resolved.environment, OPENCODE_SERVER_PASSWORD: serverPassword },
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OpenCodeRuntimeModule.OpenCodeRuntimeError({
                operation: error.operation,
                detail: error.detail.split(resolved.environment[API_KEY_ENV]!).join("[redacted]"),
              }),
          ),
        );
    });

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer: (connectInput) => {
      if (connectInput.serverUrl?.trim()) {
        return Effect.fail(
          new OpenCodeRuntimeModule.OpenCodeRuntimeError({
            operation: "connectToOpenCodeServer",
            detail: `An OpenCode aix profile starts its own server; remove the Server URL to use profile ${input.profileName}.`,
          }),
        );
      }
      return startOpenCodeServerProcess({
        binaryPath: connectInput.binaryPath,
        directory: connectInput.directory,
        ...(connectInput.serverPassword !== undefined
          ? { serverPassword: connectInput.serverPassword }
          : {}),
        ...(connectInput.environment !== undefined
          ? { environment: connectInput.environment }
          : {}),
        ...(connectInput.port !== undefined ? { port: connectInput.port } : {}),
        ...(connectInput.hostname !== undefined ? { hostname: connectInput.hostname } : {}),
        ...(connectInput.timeoutMs !== undefined ? { timeoutMs: connectInput.timeoutMs } : {}),
      }).pipe(
        Effect.map((server) => ({
          url: server.url,
          ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
          version: server.version,
          exitCode: server.exitCode,
          external: false,
        })),
      );
    },
  };
});
