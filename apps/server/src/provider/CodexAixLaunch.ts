import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as AixDiscovery from "./AixDiscovery.ts";

const PROFILE_ENV = "T3_AIX_PROFILE";
const API_KEY_ENV = "T3_AIX_API_KEY";

export class CodexAixLaunchError extends Schema.TaggedError<CodexAixLaunchError>()(
  "CodexAixLaunchError",
  {
    reason: Schema.Literals([
      "invalid-profile",
      "unsupported-endpoint",
      "launch-conflict",
      "insecure-endpoint",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "insecure-endpoint":
        return "Codex aix gateway authentication requires HTTPS outside loopback.";
      case "invalid-profile":
        return "The aix profile reference is invalid or could not be resolved.";
      case "unsupported-endpoint":
        return "Codex does not support native Anthropic aix profiles.";
      case "launch-conflict":
        return "Codex aix profiles cannot be combined with a native model or provider override.";
    }
  }
}

export interface CodexAixLaunch {
  readonly environment: NodeJS.ProcessEnv;
  readonly configArgs: ReadonlyArray<string>;
  readonly extendEnv: boolean;
}

const tomlString = (value: string) => JSON.stringify(value);

const providerConfigArgs = (endpoint: string): ReadonlyArray<string> => {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/(?:\/v1)+\/?$/u, "").replace(/\/$/u, "") + "/v1";
  return [
    "--config",
    `model_provider=${tomlString("t3_aix")}`,
    "--config",
    `model_providers.t3_aix.name=${tomlString("aix")}`,
    "--config",
    `model_providers.t3_aix.base_url=${tomlString(url.toString().replace(/\/$/u, ""))}`,
    "--config",
    `model_providers.t3_aix.env_key=${tomlString(API_KEY_ENV)}`,
    "--config",
    `model_providers.t3_aix.wire_api=${tomlString("responses")}`,
    "--config",
    "model_providers.t3_aix.requires_openai_auth=false",
  ];
};

const conflictsWithNativeLaunchArgs = (launchArgs: string): boolean => {
  const args = tokenizeCliArgs(launchArgs);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (
      arg === "--profile" ||
      arg === "-p" ||
      arg.startsWith("--profile=") ||
      (arg.startsWith("-p") && !arg.startsWith("--")) ||
      (arg.startsWith("-m") && !arg.startsWith("--")) ||
      arg === "--model" ||
      arg.startsWith("--model=")
    ) {
      return true;
    }
    const inlineConfig = arg.startsWith("--config=")
      ? arg.slice("--config=".length)
      : arg.startsWith("-c=")
        ? arg.slice("-c=".length)
        : arg.startsWith("-c") && arg.length > 2
          ? arg.slice(2)
          : undefined;
    const hasConfigValue = arg === "--config" || arg === "-c";
    const configValue = hasConfigValue ? args[index + 1] : inlineConfig;
    if (
      configValue !== undefined &&
      /^(?:model(?:\s*=|=)|model_provider(?:\s*=|=)|model_providers(?:\.|\s*=|=))/u.test(
        configValue,
      )
    ) {
      return true;
    }
    if (hasConfigValue) index++;
  }
  return false;
};

// A running Codex app-server keeps its spawn environment for its whole adapter session.
/** Resolve the non-secret profile reference immediately before a Codex child is spawned. */
export const resolveCodexAixLaunch = Effect.fn("CodexAixLaunch.resolve")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly launchArgs: string;
}): Effect.fn.Return<CodexAixLaunch, CodexAixLaunchError, ChildProcessSpawner.ChildProcessSpawner> {
  const profileName = input.environment[PROFILE_ENV];
  if (profileName === undefined) {
    return { environment: input.environment, configArgs: [], extendEnv: true };
  }
  if (profileName.trim().length === 0 || profileName !== profileName.trim()) {
    return yield* new CodexAixLaunchError({ reason: "invalid-profile" });
  }
  if (conflictsWithNativeLaunchArgs(input.launchArgs)) {
    return yield* new CodexAixLaunchError({ reason: "launch-conflict" });
  }

  const resolved = yield* AixDiscovery.resolveEnvironment(profileName).pipe(
    Effect.mapError(() => new CodexAixLaunchError({ reason: "invalid-profile" })),
  );
  if (resolved.endpointKind === "anthropic") {
    return yield* new CodexAixLaunchError({ reason: "unsupported-endpoint" });
  }

  const endpoint = new URL(resolved.endpoint);
  if (
    endpoint.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
  ) {
    return yield* new CodexAixLaunchError({ reason: "insecure-endpoint" });
  }

  const environment = { ...input.environment };
  delete environment[PROFILE_ENV];
  delete environment.OPENAI_API_KEY;
  delete environment.LITELLM_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  environment[API_KEY_ENV] = resolved.apiKey;

  return {
    environment,
    configArgs: providerConfigArgs(resolved.endpoint),
    extendEnv: false,
  };
});
