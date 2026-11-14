import type {
  ClaudeSettings,
  ProviderInstanceEnvironment,
  ResolvedProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as AixDiscovery from "../AixDiscovery.ts";
import { readClaudeSettingsEnv } from "./ClaudeSkills.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const AIX_PROFILE_ENVIRONMENT_VARIABLE = "T3_AIX_PROFILE";

class ClaudeAixProfileError extends Schema.TaggedError<ClaudeAixProfileError>()(
  "ClaudeAixProfileError",
  { reason: Schema.Literals(["invalid-reference", "settings-auth-conflict", "insecure-endpoint"]) },
) {
  override get message(): string {
    if (this.reason === "insecure-endpoint") {
      return "Claude aix gateway authentication requires HTTPS outside loopback.";
    }
    return this.reason === "invalid-reference"
      ? "The configured aix profile reference is invalid."
      : "Remove conflicting Claude settings credentials before using an aix profile.";
  }
}

export const resolveClaudeProviderInstanceEnvironment = Effect.fn(
  "resolveClaudeProviderInstanceEnvironment",
)(function* (environment: ResolvedProviderInstanceEnvironment | undefined) {
  const profileReferences =
    environment?.filter((variable) => variable.name === AIX_PROFILE_ENVIRONMENT_VARIABLE) ?? [];
  if (profileReferences.length === 0) return environment ?? [];
  const [profileReference] = profileReferences;
  if (
    profileReferences.length !== 1 ||
    profileReference === undefined ||
    profileReference.sensitive ||
    typeof profileReference.value !== "string" ||
    profileReference.value.trim().length === 0
  ) {
    return yield* new ClaudeAixProfileError({ reason: "invalid-reference" });
  }

  const resolved = yield* AixDiscovery.resolveEnvironment(profileReference.value.trim());
  const directAnthropic = resolved.endpointKind === "anthropic";
  const endpoint = new URL(resolved.endpoint);
  if (
    endpoint.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
  ) {
    return yield* new ClaudeAixProfileError({ reason: "insecure-endpoint" });
  }

  return [
    ...(environment ?? []).filter(
      (variable) =>
        variable.name !== AIX_PROFILE_ENVIRONMENT_VARIABLE &&
        variable.name !== "ANTHROPIC_BASE_URL" &&
        variable.name !== "ANTHROPIC_API_KEY" &&
        variable.name !== "ANTHROPIC_AUTH_TOKEN",
    ),
    { name: "ANTHROPIC_BASE_URL", value: resolved.endpoint, sensitive: false },
    {
      name: directAnthropic ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN",
      value: resolved.apiKey,
      sensitive: true,
    },
    {
      name: directAnthropic ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY",
      value: "",
      sensitive: false,
    },
  ];
});

export const claudeAixSettingsEnvironment = (
  environment: NodeJS.ProcessEnv,
  settingsEnvironment: Readonly<Record<string, string>> = {},
) => {
  const retained = Object.fromEntries(
    Object.entries(settingsEnvironment).filter(
      ([name]) => name !== "ANTHROPIC_API_KEY" && name !== "ANTHROPIC_AUTH_TOKEN",
    ),
  );
  return {
    ...retained,
    ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL ?? "",
    ...(environment.ANTHROPIC_AUTH_TOKEN
      ? { ANTHROPIC_API_KEY: "" }
      : { ANTHROPIC_AUTH_TOKEN: "" }),
  };
};

export const validateClaudeAixSettingsAuth = Effect.fn("validateClaudeAixSettingsAuth")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
  launchSettingsEnvironment: Readonly<Record<string, string>> = {},
) {
  const settings = yield* readClaudeSettingsEnv(config, cwd, environment, {
    forAixProfile: true,
  });
  const activeCredential = environment.ANTHROPIC_AUTH_TOKEN
    ? "ANTHROPIC_AUTH_TOKEN"
    : "ANTHROPIC_API_KEY";
  if (
    settings[activeCredential] !== undefined ||
    launchSettingsEnvironment[activeCredential] !== undefined
  ) {
    return yield* new ClaudeAixProfileError({ reason: "settings-auth-conflict" });
  }
});

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Changing HOME hides macOS Keychain credentials; use CLAUDE_CONFIG_DIR to keep login access.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

// A Claude Code session that launched T3 exports these. A claude spawned with them acts as part of
// that session: its session id, messaging socket and token, and effort.
const CLAUDE_HOST_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
];

/**
 * Base env for the Claude processes T3 Code runs, before `makeClaudeEnvironment`.
 * Claude Code reads its entrypoint from the process env, not its settings `env`, so T3 Code applies that override itself.
 */
export const mergeClaudeProcessEnvironment = Effect.fn("mergeClaudeProcessEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...hostEnvironment,
    CLAUDE_CODE_ENTRYPOINT: "t3-code",
  };
  for (const name of CLAUDE_HOST_SESSION_VARIABLES) delete baseEnvironment[name];
  // The desktop runs the server as Node through Electron. Commands Claude runs inherit its env, so
  // an Electron app they start (T3 Code itself, VS Code) would run as Node and exit.
  delete baseEnvironment.ELECTRON_RUN_AS_NODE;
  const environment = yield* mergeProviderInstanceEnvironment(instanceEnvironment, baseEnvironment);
  const settingsEntrypoint = (yield* readClaudeSettingsEnv(config, undefined, environment))
    .CLAUDE_CODE_ENTRYPOINT;
  return settingsEntrypoint
    ? { ...environment, CLAUDE_CODE_ENTRYPOINT: settingsEntrypoint }
    : environment;
});

/** managed-mcp.json excludes other MCP config and forbids --strict-mcp-config; omit the flag when present. */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/** Separate spawn env from login commands to preserve literal paths, including relative inherited values. */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
