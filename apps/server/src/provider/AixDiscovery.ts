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
  "gateway-rejected",
  "catalog-unsupported",
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

const CatalogModel = Schema.Struct({
  id: Schema.NonEmptyString,
  mode: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  display_name: Schema.NullOr(Schema.String),
  context_tokens: Schema.NullOr(Schema.Finite),
  max_output_tokens: Schema.NullOr(Schema.Finite),
  reasoning: Schema.NullOr(
    Schema.Struct({
      efforts: Schema.Array(Schema.String),
      default_effort: Schema.NullOr(Schema.String),
    }),
  ),
  pricing: Schema.NullOr(
    Schema.Struct({
      input_per_million: Schema.NullOr(Schema.Finite),
      output_per_million: Schema.NullOr(Schema.Finite),
      cache_read_per_million: Schema.NullOr(Schema.Finite),
      cache_write_per_million: Schema.NullOr(Schema.Finite),
    }),
  ),
});

const CatalogEnvelope = Schema.Struct({
  schema_version: Schema.Literal(1),
  command: Schema.Literal("models"),
  data: Schema.Struct({
    models: Schema.Array(CatalogModel),
    sources: Schema.Struct({ model_info: Schema.Boolean }),
  }),
});

const EnvironmentJson = Schema.Record(Schema.String, Schema.String);

const BudgetLayer = Schema.Struct({
  // Unknown scopes are kept, so a new gateway layer does not hide the budget.
  scope: Schema.String,
  budget_usd: Schema.NullOr(Schema.Finite),
  spent_usd: Schema.Finite,
  resets_at: Schema.optional(Schema.NullOr(Schema.String)),
  budget_duration: Schema.optional(Schema.NullOr(Schema.String)),
});

const BudgetStatus = Schema.Struct({
  status: Schema.Literals(["available", "unsupported", "unavailable"]),
  project_id: Schema.NullOr(Schema.String),
  layers: Schema.NullOr(Schema.Array(BudgetLayer)),
  key_fingerprint: Schema.NullOr(Schema.String),
  gateway: Schema.Struct({ gateway: Schema.NullOr(Schema.String) }),
});

const SpendEnvelope = Schema.Struct({
  schema_version: Schema.Literal(1),
  command: Schema.Literal("spend"),
  data: BudgetStatus,
});

// `--error-format json` writes this to stderr; codes are stable, messages are not.
const ErrorEnvelope = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({ code: Schema.String, category: Schema.String }),
  }),
);

export type AixCatalogModel = typeof CatalogModel.Type;
export type AixBudgetLayer = typeof BudgetLayer.Type;
export type AixBudgetStatus = typeof BudgetStatus.Type;

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

const COMMAND_TIMEOUT = Duration.seconds(15);
// key/info takes ~12s on a cache miss; legacy LiteLLM may need a second route.
const BUDGET_REQUEST_TIMEOUT = "20s";
const BUDGET_COMMAND_TIMEOUT = Duration.seconds(45);
// T3 shows budgets at most about a minute old; aix's own cache TTL is an hour.
const BUDGET_MAX_AGE = "60s";
const CATALOG_REQUEST_TIMEOUT = "20s";
const CATALOG_COMMAND_TIMEOUT = Duration.seconds(90);
// T3 keeps its own 24h catalog; a read older than this goes back to the gateway.
const CATALOG_MAX_AGE = "1h";
const STDOUT_LIMIT = 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

const collectBounded = <E, R>(stream: Stream.Stream<Uint8Array, E, R>, limit: number) =>
  stream.pipe(
    Stream.runFold(
      () => ({ bytes: new Uint8Array(limit), byteLength: 0, exceeded: false }),
      (output, chunk) => {
        if (output.exceeded) return output;
        if (output.byteLength + chunk.byteLength > limit) {
          output.exceeded = true;
          return output;
        }
        output.bytes.set(chunk, output.byteLength);
        output.byteLength += chunk.byteLength;
        return output;
      },
    ),
  );

const decodeOutput = (output: { readonly bytes: Uint8Array; readonly byteLength: number }) =>
  new TextDecoder().decode(output.bytes.subarray(0, output.byteLength));

const decodeErrorEnvelope = Schema.decodeUnknownOption(ErrorEnvelope);

const failureReason = (code: string, category: string): AixDiscoveryError["reason"] => {
  switch (code) {
    case "profile_not_found":
    case "no_profile_selected":
      return "profile-not-found";
    case "chatgpt_unsupported":
    case "chatgpt_login_required":
    case "chatgpt_tool_unsupported":
    case "chatgpt_auth_failed":
      return "oauth-unsupported";
    case "gateway_timeout":
      return "timeout";
  }
  return category === "authentication"
    ? "gateway-rejected"
    : category === "network"
      ? "gateway-unavailable"
      : "command-failed";
};

const runAix = Effect.fn("AixDiscovery.runAix")(function* (
  args: ReadonlyArray<string>,
  timeout: Duration.Duration = COMMAND_TIMEOUT,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(ChildProcess.make("aix", ["--error-format", "json", ...args], { stdin: "ignore" }))
    .pipe(
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
    ).pipe(Effect.timeoutOption(timeout)),
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
    const reason = stderr.exceeded
      ? "command-failed"
      : Option.match(decodeErrorEnvelope(decodeOutput(stderr)), {
          onNone: () => "command-failed" as const,
          onSome: ({ error }) => failureReason(error.code, error.category),
        });
    return yield* new AixDiscoveryError({ reason });
  }
  return decodeOutput(stdout);
}, Effect.scoped);

const JsonUnknown = Schema.fromJsonString(Schema.Unknown);
const decodeJsonUnknown = Schema.decodeEffect(JsonUnknown);
const decodeProfilesEnvelope = Schema.decodeUnknownEffect(ProfilesEnvelope);
const decodeModelsEnvelope = Schema.decodeUnknownEffect(ModelsEnvelope);
const decodeCatalogEnvelope = Schema.decodeUnknownEffect(CatalogEnvelope);
const decodeEnvironmentJson = Schema.decodeUnknownEffect(EnvironmentJson);
const decodeSpendEnvelope = Schema.decodeUnknownEffect(SpendEnvelope);

const parseJson = Effect.fn("AixDiscovery.parseJson")(function* (output: string) {
  return yield* decodeJsonUnknown(output).pipe(
    Effect.mapError(() => new AixDiscoveryError({ reason: "invalid-json" })),
  );
});

export const listProfiles = Effect.fn("AixDiscovery.listProfiles")(function* () {
  const output = yield* runAix(["profiles", "--json"]);
  const json = yield* parseJson(output);
  const envelope = yield* decodeProfilesEnvelope(json).pipe(
    Effect.mapError(() => new AixDiscoveryError({ reason: "invalid-schema" })),
  );
  return envelope.data;
});

export const listModels = Effect.fn("AixDiscovery.listModels")(function* (profileName: string) {
  const output = yield* runAix(["--json", "models", profileName]);
  const json = yield* parseJson(output);
  const envelope = yield* decodeModelsEnvelope(json).pipe(
    Effect.mapError(() => new AixDiscoveryError({ reason: "invalid-schema" })),
  );
  return envelope.data.models;
});

/** LiteLLM model metadata through aix's shared catalog cache; `refresh` skips that cache. */
export const listCatalog = Effect.fn("AixDiscovery.listCatalog")(function* (
  profileName: string,
  refresh: boolean,
) {
  const output = yield* runAix(
    [
      "--json",
      "--non-interactive",
      "--timeout",
      CATALOG_REQUEST_TIMEOUT,
      "models",
      profileName,
      "--detailed",
      ...(refresh ? ["--refresh"] : ["--max-age", CATALOG_MAX_AGE]),
    ],
    CATALOG_COMMAND_TIMEOUT,
  );
  const json = yield* parseJson(output);
  const envelope = yield* decodeCatalogEnvelope(json).pipe(
    Effect.mapError(() => new AixDiscoveryError({ reason: "invalid-schema" })),
  );
  // Without /v2/model/info the gateway is not LiteLLM; an unknown gateway is never assumed.
  if (!envelope.data.sources.model_info) {
    return yield* new AixDiscoveryError({ reason: "catalog-unsupported" });
  }
  return envelope.data.models;
});

/** Budget through aix's shared on-disk cache, re-read from the gateway when over a minute old. */
export const readBudget = Effect.fn("AixDiscovery.readBudget")(function* (profileName: string) {
  const output = yield* runAix(
    [
      "--json",
      "--non-interactive",
      "--timeout",
      BUDGET_REQUEST_TIMEOUT,
      "spend",
      profileName,
      "--max-age",
      BUDGET_MAX_AGE,
    ],
    BUDGET_COMMAND_TIMEOUT,
  );
  const json = yield* parseJson(output);
  const envelope = yield* decodeSpendEnvelope(json).pipe(
    Effect.mapError(() => new AixDiscoveryError({ reason: "invalid-schema" })),
  );
  return envelope.data;
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

/** aix reports the gateway kind it knows from config or an earlier budget read; older aix does not. */
const classifyEndpoint = (endpoint: URL, gatewayKind: string | undefined): AixEndpointKind => {
  if (
    gatewayKind === "anthropic" ||
    (endpoint.protocol === "https:" && endpoint.hostname === "api.anthropic.com")
  ) {
    return "anthropic";
  }
  return gatewayKind === "litellm" ? "litellm" : "unknown";
};

export const resolveEnvironment = Effect.fn("AixDiscovery.resolveEnvironment")(function* (
  profileName: string,
): Effect.fn.Return<
  ResolvedEnvironment,
  AixDiscoveryError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const output = yield* runAix(["env", profileName, "--format", "json"]);
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

  const endpointKind = classifyEndpoint(endpoint, environment.AIX_GATEWAY_KIND);
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
