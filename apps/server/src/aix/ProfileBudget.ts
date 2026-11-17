import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as AixDiscovery from "../provider/AixDiscovery.ts";

// Gateway budgets are decimal strings; legacy LiteLLM also accepts numeric amounts.
const Amount = Schema.Union([Schema.Finite, Schema.FiniteFromString]);

const KeyInfo = Schema.Struct({
  info: Schema.Struct({
    spend: Schema.optional(Schema.NullOr(Amount)),
    max_budget: Schema.optional(Schema.NullOr(Amount)),
    budget_duration: Schema.optional(Schema.NullOr(Schema.String)),
    budget_reset_at: Schema.optional(Schema.NullOr(Schema.String)),
    budget_period_start: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
export type KeyInfo = typeof KeyInfo.Type;
export const decodeKeyInfo = Schema.decodeUnknownOption(KeyInfo);

const AiHubLayer = Schema.Struct({
  scope: Schema.Literals(["key", "personal", "project", "tenant"]),
  budget_usd: Schema.NullOr(Amount),
  spent_usd: Amount,
  remaining_usd: Schema.NullOr(Amount),
  period_start: Schema.String,
});
const AiHubKeyInfo = Schema.Struct({
  kind: Schema.Literals(["personal", "project"]),
  project_id: Schema.NullOr(Schema.String),
  layers: Schema.Array(AiHubLayer),
});
export type AiHubKeyInfo = typeof AiHubKeyInfo.Type;
export const decodeAiHubKeyInfo = Schema.decodeUnknownOption(AiHubKeyInfo);

const DURATION_MINUTES = { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080, mo: 43200 } as const;

/** LiteLLM writes budget windows like `30d`, `1h` or `1mo`. */
const durationMinutes = (value: string | null | undefined): number | undefined => {
  const match = /^(\d+)(mo|s|m|h|d|w)$/u.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const minutes = Math.round(
    Number(match[1]) * DURATION_MINUTES[match[2] as keyof typeof DURATION_MINUTES],
  );
  return minutes > 0 ? minutes : undefined;
};

const isoTime = (value: string | null | undefined): string | undefined =>
  value == null
    ? undefined
    : Option.getOrUndefined(Option.map(DateTime.make(value), DateTime.formatIso));

const MONTHLY_WINDOW_MINUTES = DURATION_MINUTES.mo;

// Gateways that report only a period start (the AI Hub) reset monthly; explicit fields win.
const monthlyResetAfter = (
  periodStart: string | null | undefined,
  checkedAt: string,
): string | undefined => {
  if (periodStart == null) return undefined;
  const start = Option.getOrUndefined(DateTime.make(periodStart));
  const now = Option.getOrUndefined(DateTime.make(checkedAt));
  if (start === undefined || now === undefined) return undefined;
  const months = Math.max(
    1,
    (DateTime.getPartUtc(now, "year") - DateTime.getPartUtc(start, "year")) * 12 +
      DateTime.getPartUtc(now, "month") -
      DateTime.getPartUtc(start, "month"),
  );
  const reset = DateTime.add(start, { months });
  return DateTime.formatIso(
    DateTime.isGreaterThan(reset, now) ? reset : DateTime.add(start, { months: months + 1 }),
  );
};

const budgetWindowId = (profileName: string, credentialFingerprint?: string) =>
  `aix-budget:${profileName}${credentialFingerprint ? `#credential:${credentialFingerprint}` : ""}`;

export function keyInfoUsageLimits(input: {
  readonly profileName: string;
  readonly keyInfo: KeyInfo;
  readonly checkedAt: string;
  readonly credentialFingerprint?: string;
}): ServerProviderUsageLimits {
  const {
    spend,
    max_budget: maxBudget,
    budget_duration,
    budget_reset_at,
    budget_period_start,
  } = input.keyInfo.info;
  if (maxBudget == null) {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "unsupported",
      message: "This aix profile's key has no budget limit.",
    });
  }
  // A $0 cap has no percentage, so it cannot be a window.
  if (maxBudget <= 0) {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "unsupported",
      message: "This aix profile's key has a $0 budget.",
    });
  }
  if (spend == null) {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "probeFailed",
      message: "The aix gateway returned an unrecognized budget.",
    });
  }
  const monthlyReset =
    budget_reset_at == null && budget_duration == null
      ? monthlyResetAfter(budget_period_start, input.checkedAt)
      : undefined;
  const resetsAt = isoTime(budget_reset_at) ?? monthlyReset;
  const windowDurationMins =
    durationMinutes(budget_duration) ??
    (monthlyReset === undefined ? undefined : MONTHLY_WINDOW_MINUTES);
  return {
    ...makeUsageLimits({
      checkedAt: input.checkedAt,
      windows: [
        {
          id: budgetWindowId(input.profileName, input.credentialFingerprint),
          kind: "other",
          label: `Gateway budget · ${input.profileName}`,
          usedPercent: clampPercent((spend / maxBudget) * 100),
          amounts: { currency: "USD", spent: spend, total: maxBudget },
          ...(resetsAt === undefined ? {} : { resetsAt }),
          ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
        },
      ],
    }),
    ...(input.credentialFingerprint === undefined
      ? {}
      : { credentialFingerprint: input.credentialFingerprint }),
  };
}

export function aiHubKeyInfoUsageLimits(input: {
  readonly profileName: string;
  readonly keyInfo: AiHubKeyInfo;
  readonly checkedAt: string;
  readonly credentialFingerprint?: string;
}): ServerProviderUsageLimits {
  const layers = input.keyInfo.layers;
  const keyLayer = layers.find((layer) => layer.scope === "key");
  const personalLayer = layers.find((layer) => layer.scope === "personal");
  const projectLayer = layers.find((layer) => layer.scope === "project");
  const selectedLayer =
    keyLayer?.budget_usd !== null && keyLayer?.budget_usd !== undefined
      ? keyLayer
      : personalLayer?.budget_usd !== null && personalLayer?.budget_usd !== undefined
        ? personalLayer
        : undefined;
  const aixProject =
    input.keyInfo.project_id == null
      ? undefined
      : {
          id: input.keyInfo.project_id,
          ...(projectLayer?.budget_usd == null
            ? {}
            : {
                amounts: {
                  currency: "USD" as const,
                  spent: projectLayer.spent_usd,
                  total: projectLayer.budget_usd,
                },
              }),
        };
  if (!selectedLayer || selectedLayer.budget_usd === null) {
    return {
      ...makeUnavailableUsageLimits({
        checkedAt: input.checkedAt,
        reason: "unsupported",
        message: "This aix profile's key has no budget limit.",
      }),
      ...(aixProject === undefined ? {} : { aixProject }),
      ...(input.credentialFingerprint === undefined
        ? {}
        : { credentialFingerprint: input.credentialFingerprint }),
    };
  }
  const total = selectedLayer.budget_usd;
  if (total <= 0) {
    return {
      ...makeUnavailableUsageLimits({
        checkedAt: input.checkedAt,
        reason: "unsupported",
        message: "This aix profile's key has a $0 budget.",
      }),
      ...(aixProject === undefined ? {} : { aixProject }),
      ...(input.credentialFingerprint === undefined
        ? {}
        : { credentialFingerprint: input.credentialFingerprint }),
    };
  }
  const resetsAt = monthlyResetAfter(selectedLayer.period_start, input.checkedAt);
  return {
    ...makeUsageLimits({
      checkedAt: input.checkedAt,
      windows: [
        {
          id: budgetWindowId(input.profileName, input.credentialFingerprint),
          kind: "other",
          label: `Gateway budget · ${input.profileName}`,
          usedPercent: clampPercent((selectedLayer.spent_usd / total) * 100),
          amounts: { currency: "USD", spent: selectedLayer.spent_usd, total },
          ...(resetsAt === undefined ? {} : { resetsAt }),
          ...(resetsAt === undefined ? {} : { windowDurationMins: MONTHLY_WINDOW_MINUTES }),
        },
      ],
    }),
    ...(aixProject === undefined ? {} : { aixProject }),
    ...(input.credentialFingerprint === undefined
      ? {}
      : { credentialFingerprint: input.credentialFingerprint }),
  };
}

const keyInfoUrl = (endpoint: string, versioned = false) => {
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  url.pathname = `${basePath}${versioned ? "/v1" : ""}/key/info`;
  return url.href;
};

// The gateway answers key/info one at a time (about 1-2s each), and other T3 servers share it.
const REQUEST_TIMEOUT = Duration.seconds(30);

type BudgetFailure =
  | { readonly _tag: "status"; readonly status: number }
  | { readonly _tag: "request" | "timeout" | "decode" };

/** Failure messages carry only an HTTP status, never the key, URL or response body. */
const failureMessage = (failure: BudgetFailure) => {
  switch (failure._tag) {
    case "status":
      return failure.status === 401 || failure.status === 403
        ? `The aix gateway rejected this profile's key (HTTP ${failure.status}).`
        : `The aix gateway budget could not be read (HTTP ${failure.status}).`;
    case "timeout":
      return "The aix gateway budget request timed out.";
    case "decode":
      return "The aix gateway returned an unrecognized budget.";
    case "request":
      return "The aix gateway could not be reached.";
  }
};

const readJson = Effect.fn("AixProfileBudget.readJson")(function* (
  environment: AixDiscovery.ResolvedEnvironment,
  versioned: boolean,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(keyInfoUrl(environment.endpoint, versioned)).pipe(
    HttpClientRequest.setHeader("authorization", `Bearer ${environment.apiKey}`),
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  const body = yield* client.execute(request).pipe(
    // Endpoint queries may carry credentials; keep HTTP URL attributes out of traces.
    Effect.withTracerEnabled(false),
    Effect.mapError((): BudgetFailure => ({ _tag: "request" })),
    Effect.flatMap((response) =>
      response.status < 200 || response.status >= 300
        ? Effect.fail<BudgetFailure>({ _tag: "status", status: response.status })
        : response.json.pipe(Effect.mapError((): BudgetFailure => ({ _tag: "decode" }))),
    ),
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail<BudgetFailure>({ _tag: "timeout" }),
    }),
  );
  return body;
});

const readKeyInfo = Effect.fn("AixProfileBudget.readKeyInfo")(function* (
  environment: AixDiscovery.ResolvedEnvironment,
) {
  const versioned = yield* readJson(environment, true).pipe(Effect.result);
  if (Result.isSuccess(versioned)) {
    const decoded = decodeAiHubKeyInfo(versioned.success);
    if (Option.isSome(decoded)) return { kind: "aiHub" as const, keyInfo: decoded.value };
  } else if (
    versioned.failure._tag !== "decode" &&
    !(versioned.failure._tag === "status" && versioned.failure.status === 404)
  ) {
    return yield* Effect.fail(versioned.failure);
  }

  const legacy = yield* readJson(environment, false);
  return yield* Option.match(decodeKeyInfo(legacy), {
    onNone: () => Effect.fail<BudgetFailure>({ _tag: "decode" }),
    onSome: (keyInfo) => Effect.succeed({ kind: "legacy" as const, keyInfo }),
  });
});

/** Seam for tests: production resolves the profile through `aix env`. */
export interface AixBudgetSource {
  readonly resolveEnvironment: (
    profileName: string,
  ) => Effect.Effect<AixDiscovery.ResolvedEnvironment, AixDiscovery.AixDiscoveryError>;
}

const readProfileBudget = Effect.fn("AixProfileBudget.read")(function* (
  source: AixBudgetSource,
  profileName: string,
  digest: Digest.Digest["Service"],
  serialize: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const environment = yield* source.resolveEnvironment(profileName).pipe(Effect.option);
  if (Option.isNone(environment)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "aix could not resolve this profile.",
    });
  }
  if (environment.value.endpointKind === "anthropic") {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "This aix profile connects directly to Anthropic, which reports no gateway budget.",
    });
  }
  const keyInfo = yield* serialize(readKeyInfo(environment.value)).pipe(Effect.result);
  if (Result.isSuccess(keyInfo)) {
    const credentialFingerprint = yield* digest
      .digest(
        Digest.sha256,
        new TextEncoder().encode(
          `aix-profile-budget\0${profileName}\0${keyInfoUrl(environment.value.endpoint)}\0${environment.value.apiKey}`,
        ),
      )
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return keyInfo.success.kind === "aiHub"
      ? aiHubKeyInfoUsageLimits({
          profileName,
          keyInfo: keyInfo.success.keyInfo,
          checkedAt,
          credentialFingerprint,
        })
      : keyInfoUsageLimits({
          profileName,
          keyInfo: keyInfo.success.keyInfo,
          checkedAt,
          credentialFingerprint,
        });
  }
  const failure = keyInfo.failure;
  return makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: failureMessage(failure),
  });
});

// Instances of one profile refresh within moments of each other; one read serves them all.
const BUDGET_TTL = Duration.minutes(1);

export class AixProfileBudget extends Context.Service<
  AixProfileBudget,
  {
    readonly usageLimits: (profileName: string) => Effect.Effect<ServerProviderUsageLimits>;
  }
>()("t3/aix/ProfileBudget/AixProfileBudget") {}

export const make = Effect.fn("AixProfileBudget.make")(function* (source: AixBudgetSource) {
  const http = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  const gateway = yield* Semaphore.make(1);
  const cache = yield* Cache.make({
    lookup: (profileName: string) =>
      readProfileBudget(source, profileName, digest, gateway.withPermits(1)).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      ),
    capacity: 64,
    timeToLive: BUDGET_TTL,
  });
  return AixProfileBudget.of({
    usageLimits: Effect.fn("AixProfileBudget.usageLimits")(function* (profileName) {
      return { ...(yield* Cache.get(cache, profileName)), profileName };
    }),
  });
});

export const layer = Layer.effect(
  AixProfileBudget,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* make({
      resolveEnvironment: (profileName) =>
        AixDiscovery.resolveEnvironment(profileName).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
    });
  }),
);

/** Attaches a profile budget to its designated Claude fallback instance when OpenCode is absent. */
export const withAixProfileBudget =
  (profileName: string | undefined, isBudgetOwner = false) =>
  (provider: ServerProvider): Effect.Effect<ServerProvider> =>
    profileName === undefined ||
    !isBudgetOwner ||
    !provider.enabled ||
    provider.driver !== "claudeAgent"
      ? Effect.succeed(provider)
      : Effect.serviceOption(AixProfileBudget).pipe(
          Effect.flatMap((service) =>
            Option.isNone(service)
              ? Effect.succeed(provider)
              : service.value
                  .usageLimits(profileName)
                  .pipe(Effect.map((usageLimits) => ({ ...provider, usageLimits }))),
          ),
        );
