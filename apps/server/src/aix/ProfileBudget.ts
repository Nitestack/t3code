import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/process";

import * as AixDiscovery from "../provider/AixDiscovery.ts";

const DURATION_MINUTES = { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080, mo: 43200 } as const;

/** aix reports budget windows like `30d`, `1h` or `1mo`. */
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

const budgetWindowId = (profileName: string, credentialFingerprint?: string) =>
  `aix-budget:${profileName}${credentialFingerprint ? `#credential:${credentialFingerprint}` : ""}`;

export interface AixBudget {
  readonly project_id?: string | null | undefined;
  readonly layers: ReadonlyArray<AixDiscovery.AixBudgetLayer>;
}

export function budgetUsageLimits(input: {
  readonly profileName: string;
  readonly budget: AixBudget;
  readonly checkedAt: string;
  readonly credentialFingerprint?: string;
}): ServerProviderUsageLimits {
  const layers = input.budget.layers;
  const keyLayer = layers.find((layer) => layer.scope === "key");
  const personalLayer = layers.find((layer) => layer.scope === "personal");
  const projectLayer = layers.find((layer) => layer.scope === "project");
  const selectedLayer =
    keyLayer?.budget_usd != null
      ? keyLayer
      : personalLayer?.budget_usd != null
        ? personalLayer
        : undefined;
  const projectId = input.budget.project_id?.trim();
  const aixProject = !projectId
    ? undefined
    : {
        id: projectId,
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
  const extras = {
    ...(aixProject === undefined ? {} : { aixProject }),
    ...(input.credentialFingerprint === undefined
      ? {}
      : { credentialFingerprint: input.credentialFingerprint }),
  };
  const total = selectedLayer?.budget_usd;
  if (selectedLayer === undefined || total == null || total <= 0) {
    return {
      ...makeUnavailableUsageLimits({
        checkedAt: input.checkedAt,
        reason: "unsupported",
        message:
          total == null
            ? "This aix profile's key has no budget limit."
            : "This aix profile's key has a $0 budget.",
      }),
      ...extras,
    };
  }
  const resetsAt = isoTime(selectedLayer.resets_at);
  const windowDurationMins = durationMinutes(selectedLayer.budget_duration);
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
          ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
        },
      ],
    }),
    ...extras,
  };
}

/** Failure messages carry only a failure kind, never the key, URL or aix output. */
const failureMessage = (reason: AixDiscovery.AixDiscoveryError["reason"]) => {
  switch (reason) {
    case "profile-not-found":
      return "aix could not resolve this profile.";
    case "gateway-rejected":
      return "The aix gateway rejected this profile's key.";
    case "gateway-unavailable":
      return "The aix gateway could not be reached.";
    case "timeout":
      return "The aix gateway budget request timed out.";
    case "invalid-json":
    case "invalid-schema":
      return "aix returned an unrecognized budget.";
    default:
      return "The aix gateway budget could not be read.";
  }
};

/** Seam for tests: production shells out to `aix spend`. */
export interface AixBudgetSource {
  readonly readBudget: (
    profileName: string,
  ) => Effect.Effect<AixDiscovery.AixBudgetStatus, AixDiscovery.AixDiscoveryError>;
}

const readProfileBudget = Effect.fn("AixProfileBudget.read")(function* (
  source: AixBudgetSource,
  profileName: string,
  serialize: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const read = yield* serialize(source.readBudget(profileName)).pipe(Effect.result);
  if (Result.isFailure(read)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: failureMessage(read.failure.reason),
    });
  }
  const budget = read.success;
  if (budget.status === "unsupported") {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message:
        budget.gateway.gateway === "anthropic"
          ? "This aix profile connects directly to Anthropic, which reports no gateway budget."
          : "This aix gateway reports no budget for this profile's key.",
    });
  }
  if (budget.status === "unavailable" || budget.layers === null) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "The aix gateway budget could not be read.",
    });
  }
  return budgetUsageLimits({
    profileName,
    budget: { project_id: budget.project_id, layers: budget.layers },
    checkedAt,
    ...(budget.key_fingerprint === null ? {} : { credentialFingerprint: budget.key_fingerprint }),
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
  // The gateway answers key/info one at a time, and other T3 servers share it.
  const gateway = yield* Semaphore.make(1);
  const cache = yield* Cache.make({
    lookup: (profileName: string) => readProfileBudget(source, profileName, gateway.withPermits(1)),
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
      readBudget: (profileName) =>
        AixDiscovery.readBudget(profileName).pipe(
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
