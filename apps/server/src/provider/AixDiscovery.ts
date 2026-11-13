import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";

const FailureReason = Schema.Literals([
  "aix-not-found",
  "timeout",
  "command-failed",
  "gateway-unavailable",
  "profile-not-found",
  "oauth-unsupported",
  "invalid-json",
  "invalid-schema",
  "invalid-endpoint",
  "output-too-large",
]);

export class AixDiscoveryError extends Schema.TaggedError<AixDiscoveryError>()(
  "AixDiscoveryError",
  { reason: FailureReason },
) {}

const Profile = Schema.Struct({
  name: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
});

const ProfilesEnvelope = Schema.Struct({
  schema_version: Schema.Literal(1),
  command: Schema.Literal("profiles"),
  data: Schema.Array(Profile),
});

const ModelsEnvelope = Schema.Struct({
  schema_version: Schema.Literal(1),
  command: Schema.Literal("models"),
  data: Schema.Struct({
    models: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
    filter: Schema.NullOr(Schema.String),
  }),
});

const EnvironmentJson = Schema.Record(Schema.String, Schema.String);

export type AixProfile = Schema.Schema.Type<typeof Profile>;
export type AixModel = { readonly id: string };
export type AixEndpointKind = "anthropic" | "litellm" | "unknown";

/** Contains a resolved API key; keep it inside the server process and out of logs/contracts. */
export interface ResolvedEnvironment {
  readonly profileName: string;
  readonly endpoint: string;
  readonly endpointKind: AixEndpointKind;
  readonly apiKey: string;
}

export interface ResolveEnvironmentOptions {
  // aix env omits gateway/provider metadata, so only the caller can identify other known gateways.
  readonly endpointKind?: Exclude<AixEndpointKind, "unknown">;
}

const COMMAND_TIMEOUT = Duration.seconds(15);
const STDOUT_LIMIT = 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

interface BoundedOutput {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly byteLength: number;
  readonly exceeded: boolean;
}

const emptyOutput: BoundedOutput = { chunks: [], byteLength: 0, exceeded: false };

const collectBounded = <E, R>(stream: Stream.Stream<Uint8Array, E, R>, limit: number) =>
  stream.pipe(
    Stream.runFold(
      () => emptyOutput,
      (output, chunk): BoundedOutput => {
        if (output.exceeded || output.byteLength + chunk.byteLength > limit) {
          return { chunks: [], byteLength: output.byteLength + chunk.byteLength, exceeded: true };
        }
        return {
          chunks: [...output.chunks, chunk],
          byteLength: output.byteLength + chunk.byteLength,
          exceeded: false,
        };
      },
    ),
  );

const decodeOutput = (output: BoundedOutput) => {
  const bytes = new Uint8Array(output.byteLength);
  let offset = 0;
  for (const chunk of output.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const runAix = Effect.fn("AixDiscovery.runAix")(function* (
  args: ReadonlyArray<string>,
  action: "profiles" | "models" | "env",
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("aix", args, { stdin: "ignore" })).pipe(
    Effect.mapError(
      (error) =>
        new AixDiscoveryError({
          reason: error.reason._tag === "NotFound" ? "aix-not-found" : "command-failed",
        }),
    ),
  );

  const result = yield* Effect.result(
    Effect.all(
      {
        stdout: collectBounded(child.stdout, STDOUT_LIMIT),
        stderr: collectBounded(child.stderr, STDERR_LIMIT),
        exitCode: child.exitCode,
      },
      { concurrency: "unbounded" },
    ).pipe(Effect.timeoutOption(COMMAND_TIMEOUT)),
  );
  if (Result.isFailure(result)) {
    yield* child.kill().pipe(Effect.orElseSucceed(() => undefined));
    return yield* new AixDiscoveryError({ reason: "command-failed" });
  }

  const completed = result.success;
  if (Option.isNone(completed)) {
    yield* child.kill().pipe(Effect.orElseSucceed(() => undefined));
    return yield* new AixDiscoveryError({ reason: "timeout" });
  }

  const { stdout, stderr, exitCode } = completed.value;
  if (stdout.exceeded) return yield* new AixDiscoveryError({ reason: "output-too-large" });
  if (Number(exitCode) !== 0) {
    if (stderr.exceeded) {
      return yield* new AixDiscoveryError({
        reason:
          action === "models" && Number(exitCode) === 5 ? "gateway-unavailable" : "command-failed",
      });
    }
    const errorOutput = decodeOutput(stderr).toLowerCase();
    const reason =
      action === "env" && /chatgpt|oauth|sign in with chatgpt/u.test(errorOutput)
        ? "oauth-unsupported"
        : /profile.{0,50}(not found|does not exist|unknown)|(?:not found|unknown).{0,50}profile/u.test(
              errorOutput,
            )
          ? "profile-not-found"
          : action === "models" &&
              (Number(exitCode) === 5 ||
                /connection refused|timed out|gateway|network/u.test(errorOutput))
            ? "gateway-unavailable"
            : "command-failed";
    return yield* new AixDiscoveryError({ reason });
  }
  return decodeOutput(stdout);
}, Effect.scoped);

const JsonUnknown = Schema.fromJsonString(Schema.Unknown);
const decodeJsonUnknown = Schema.decodeEffect(JsonUnknown);
const decodeProfilesEnvelope = Schema.decodeUnknownEffect(ProfilesEnvelope);
const decodeModelsEnvelope = Schema.decodeUnknownEffect(ModelsEnvelope);
const decodeEnvironmentJson = Schema.decodeUnknownEffect(EnvironmentJson);

const parseJson = Effect.fn("AixDiscovery.parseJson")(function* (output: string) {
  return yield* decodeJsonUnknown(output).pipe(
    Effect.mapError(() => new AixDiscoveryError({ reason: "invalid-json" })),
  );
});

export const listProfiles = Effect.fn("AixDiscovery.listProfiles")(function* () {
  const output = yield* runAix(["profiles", "--json"], "profiles");
  const json = yield* parseJson(output);
  const envelope = yield* decodeProfilesEnvelope(json).pipe(
    Effect.mapError(() => new AixDiscoveryError({ reason: "invalid-schema" })),
  );
  return envelope.data;
});

export const listModels = Effect.fn("AixDiscovery.listModels")(function* (profileName: string) {
  const output = yield* runAix(["--json", "models", profileName], "models");
  const json = yield* parseJson(output);
  const envelope = yield* decodeModelsEnvelope(json).pipe(
    Effect.mapError(() => new AixDiscoveryError({ reason: "invalid-schema" })),
  );
  return envelope.data.models;
});

const resolveEndpoint = (environment: Record<string, string>): string | undefined => {
  const anthropicEndpoint = environment.ANTHROPIC_BASE_URL;
  if (anthropicEndpoint !== undefined) return anthropicEndpoint;

  const openAiEndpoint = environment.OPENAI_BASE_URL ?? environment.LITELLM_BASE_URL;
  if (openAiEndpoint === undefined) return undefined;
  try {
    const url = new URL(openAiEndpoint);
    if (url.pathname.endsWith("/v1")) url.pathname = url.pathname.slice(0, -3);
    return url.toString().replace(/\/$/u, "");
  } catch {
    return openAiEndpoint;
  }
};

const classifyEndpoint = (
  endpoint: URL,
  override: ResolveEnvironmentOptions["endpointKind"],
): AixEndpointKind => {
  if (endpoint.protocol === "https:" && endpoint.hostname === "api.anthropic.com") {
    return "anthropic";
  }
  return override ?? "unknown";
};

export const resolveEnvironment = Effect.fn("AixDiscovery.resolveEnvironment")(function* (
  profileName: string,
  options: ResolveEnvironmentOptions = {},
): Effect.fn.Return<
  ResolvedEnvironment,
  AixDiscoveryError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const output = yield* runAix(["env", profileName, "--format", "json"], "env");
  const json = yield* parseJson(output);
  const environment = yield* decodeEnvironmentJson(json).pipe(
    Effect.mapError(() => new AixDiscoveryError({ reason: "invalid-schema" })),
  );
  if (environment.AIX_PROFILE !== profileName) {
    return yield* new AixDiscoveryError({ reason: "invalid-schema" });
  }

  const rawEndpoint = resolveEndpoint(environment);
  if (rawEndpoint === undefined) return yield* new AixDiscoveryError({ reason: "invalid-schema" });

  const endpoint = yield* Effect.try({
    try: () => new URL(rawEndpoint),
    catch: () => new AixDiscoveryError({ reason: "invalid-endpoint" }),
  });
  if (
    (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
    endpoint.hostname.length === 0 ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0
  ) {
    return yield* new AixDiscoveryError({ reason: "invalid-endpoint" });
  }

  const endpointKind = classifyEndpoint(endpoint, options.endpointKind);
  const apiKey =
    endpointKind === "anthropic"
      ? environment.ANTHROPIC_API_KEY
      : (environment.OPENAI_API_KEY ?? environment.LITELLM_API_KEY);
  if (apiKey === undefined || apiKey.length === 0) {
    return yield* new AixDiscoveryError({ reason: "invalid-schema" });
  }

  return {
    profileName,
    endpoint: endpoint.toString().replace(/\/$/u, ""),
    endpointKind,
    apiKey,
  };
});
