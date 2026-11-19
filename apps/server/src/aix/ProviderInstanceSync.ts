import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceMutation,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeUtil from "node:util";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import { ChildProcessSpawner } from "effect/process";

import * as AixDiscovery from "../provider/AixDiscovery.ts";
import { OPENCODE_AIX_PROVIDER_ID } from "../provider/OpenCodeAixLaunch.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as AixCatalogCache from "./AixCatalogCache.ts";
import { type CatalogModel, catalogModels, modelName } from "./ModelCatalog.ts";
import { type AixModelRoute, routeCatalogModel } from "./ModelRouting.ts";

/** Set to `1` on the server host to let aix profiles create provider instances. */
const AIX_ENABLED_ENVIRONMENT_VARIABLE = "T3CODE_AIX";
/** Read by the Codex, Claude, and OpenCode drivers at launch. */
const AIX_PROFILE_VARIABLE = "T3_AIX_PROFILE";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE_CODE = ProviderDriverKind.make("claudeAgent");
const OPENCODE = ProviderDriverKind.make("opencode");
const SUPPORTED_DRIVERS: ReadonlyArray<ProviderDriverKind> = [CODEX, CLAUDE_CODE, OPENCODE];

export interface AixRoutedModel {
  readonly id: string;
  readonly displayName: string;
  readonly catalogMetadata?: {
    readonly family?: string;
    readonly contextTokens?: number;
    readonly maxOutputTokens?: number;
    readonly pricing?: CatalogModel["pricing"];
    readonly reasoning?: CatalogModel["reasoning"];
  };
}

export type AixRouteSource = "anthropic" | "litellm";

const routeFor = (source: AixRouteSource, modelId: string): AixModelRoute => {
  if (source === "anthropic") return "anthropic-direct-messages";
  const name = modelName(modelId);
  if (name.startsWith("claude-")) return "litellm-anthropic-messages";
  // gpt-oss is an open-weight chat model served from the chat route, not the Responses API.
  if (name.startsWith("gpt-") && !name.startsWith("gpt-oss")) {
    return "litellm-openai-responses";
  }
  return "litellm-openai-chat";
};

/** Routes each model to its native agent; a model without one is dropped, never substituted. */
export function routeAixModels(
  source: AixRouteSource,
  models: ReadonlyArray<CatalogModel>,
): ReadonlyMap<ProviderDriverKind, ReadonlyArray<AixRoutedModel>> {
  const routes = new Map<ProviderDriverKind, Array<AixRoutedModel>>();
  for (const model of models) {
    const routing = routeCatalogModel(model, { route: routeFor(source, model.id) });
    if (routing.kind !== "routed" || !SUPPORTED_DRIVERS.includes(routing.driverKind)) continue;
    const driverModels = routes.get(routing.driverKind) ?? [];
    const catalogMetadata = {
      ...(model.family !== undefined ? { family: model.family } : {}),
      ...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
      ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(model.pricing !== undefined ? { pricing: model.pricing } : {}),
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    };
    driverModels.push({
      id: model.id,
      displayName: model.displayName,
      ...(Object.keys(catalogMetadata).length > 0 ? { catalogMetadata } : {}),
    });
    routes.set(routing.driverKind, driverModels);
  }
  return routes;
}

export interface AixObservedProfile {
  readonly name: string;
  readonly label: string;
  readonly routes: ReadonlyMap<ProviderDriverKind, ReadonlyArray<AixRoutedModel>>;
}

const isProviderInstanceId = Schema.is(ProviderInstanceId);

/**
 * Stable per (driver, profile). The driver kind has no `-`, so the id decodes unambiguously; a
 * profile whose id would not be a valid instance id gets no instance.
 */
export function aixInstanceId(
  driver: ProviderDriverKind,
  profile: string,
): ProviderInstanceId | undefined {
  const id = `aix-${driver}-${profile}`;
  return isProviderInstanceId(id) ? ProviderInstanceId.make(id) : undefined;
}

// Ownership marker. Manual instances never carry it, so they are never rewritten.
const OwnerMarker = Schema.Struct({ aixProfile: Schema.String });
const decodeOwnerMarker = Schema.decodeUnknownOption(OwnerMarker);

const ownerProfile = (instance: ProviderInstanceConfig): string | undefined =>
  Option.getOrUndefined(decodeOwnerMarker(instance.config))?.aixProfile;

const wasDisabledBySync = (instance: ProviderInstanceConfig): boolean => {
  const config = instance.config;
  return (
    config !== null &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    (config as { readonly aixDisabledBySync?: unknown }).aixDisabledBySync === true
  );
};

const withoutSyncDisabledMarker = (config: unknown): unknown => {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return config;
  const { aixDisabledBySync: _marker, ...rest } = config as Record<string, unknown>;
  return rest;
};

const driverLabel = (driver: ProviderDriverKind) => {
  if (driver === CODEX) return "Codex";
  if (driver === OPENCODE) return "OpenCode";
  return "Claude Code";
};

// OpenCode parses a model slug at its first "/", so the provider prefix keeps upstream ids like
// `google/gemma-4-31b-it` intact.
const customModelSlug = (driver: ProviderDriverKind, modelId: string) =>
  driver === OPENCODE ? `${OPENCODE_AIX_PROVIDER_ID}/${modelId}` : modelId;

export function aixDesiredInstances(
  profiles: ReadonlyArray<AixObservedProfile>,
): Map<ProviderInstanceId, ProviderInstanceConfig> {
  const desired = new Map<ProviderInstanceId, ProviderInstanceConfig>();
  for (const profile of profiles) {
    const budgetOwner = profile.routes.has(OPENCODE)
      ? OPENCODE
      : profile.routes.has(CLAUDE_CODE)
        ? CLAUDE_CODE
        : undefined;
    for (const [driver, models] of profile.routes) {
      const instanceId = aixInstanceId(driver, profile.name);
      if (instanceId === undefined || models.length === 0) continue;
      desired.set(instanceId, {
        driver,
        displayName: `${profile.label} · ${driverLabel(driver)}`,
        aixProfileLabel: profile.label,
        enabled: true,
        environment: [{ name: AIX_PROFILE_VARIABLE, value: profile.name, sensitive: false }],
        config: {
          aixProfile: profile.name,
          ...(driver === budgetOwner && driver === CLAUDE_CODE ? { aixBudgetOwner: true } : {}),
          customModels: models.map((model) => ({
            slug: customModelSlug(driver, model.id),
            name: model.displayName,
            ...(model.catalogMetadata ? { catalogMetadata: model.catalogMetadata } : {}),
          })),
        },
      });
    }
  }
  return desired;
}

const OwnedModels = Schema.Struct({
  customModels: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      catalogMetadata: Schema.optional(
        Schema.Struct({
          pricing: Schema.optional(
            Schema.Struct({
              inputPerMillionTokens: Schema.optional(Schema.Finite),
              outputPerMillionTokens: Schema.optional(Schema.Finite),
              cachedInputPerMillionTokens: Schema.optional(Schema.Finite),
              cacheWritePerMillionTokens: Schema.optional(Schema.Finite),
            }),
          ),
        }),
      ),
    }),
  ),
});
const decodeOwnedModels = Schema.decodeUnknownOption(OwnedModels);
const OPENCODE_SLUG_PREFIX = `${OPENCODE_AIX_PROVIDER_ID}/`;

/** The gateway price of every model an aix-owned instance lists; unpriced models carry none. */
export function aixGatewayModelPrices(instances: ProviderInstanceConfigMap) {
  return Object.values(instances).flatMap((instance) => {
    if (ownerProfile(instance) === undefined) return [];
    const models = Option.getOrUndefined(decodeOwnedModels(instance.config))?.customModels ?? [];
    return models.map(({ slug, catalogMetadata }) => {
      const pricing = catalogMetadata?.pricing;
      const input = pricing?.inputPerMillionTokens;
      const output = pricing?.outputPerMillionTokens;
      return {
        model: slug.startsWith(OPENCODE_SLUG_PREFIX)
          ? slug.slice(OPENCODE_SLUG_PREFIX.length)
          : slug,
        prices:
          input === undefined || output === undefined
            ? undefined
            : {
                inputCostPerMillionTokens: input,
                outputCostPerMillionTokens: output,
                ...(pricing?.cachedInputPerMillionTokens === undefined
                  ? {}
                  : { cacheReadCostPerMillionTokens: pricing.cachedInputPerMillionTokens }),
                ...(pricing?.cacheWritePerMillionTokens === undefined
                  ? {}
                  : { cacheWriteCostPerMillionTokens: pricing.cacheWritePerMillionTokens }),
              },
      };
    });
  });
}

const sameOwnedFields = (left: ProviderInstanceConfig, right: ProviderInstanceConfig) =>
  NodeUtil.isDeepStrictEqual(
    {
      driver: left.driver,
      displayName: left.displayName,
      aixProfileLabel: left.aixProfileLabel,
      environment: left.environment,
      config: left.config,
    },
    {
      driver: right.driver,
      displayName: right.displayName,
      aixProfileLabel: right.aixProfileLabel,
      environment: right.environment,
      config: right.config,
    },
  );

/**
 * Pure diff of managed instances. A managed instance that is no longer desired is disabled, not
 * removed, so threads keep their instance. Unavailable profiles keep their instances untouched.
 */
export function planAixInstanceSync(input: {
  readonly current: ProviderInstanceConfigMap;
  readonly desired: ReadonlyMap<ProviderInstanceId, ProviderInstanceConfig>;
  readonly unavailableProfiles: ReadonlySet<string>;
}): ReadonlyArray<ProviderInstanceMutation> {
  const mutations: Array<ProviderInstanceMutation> = [];

  for (const [rawId, existing] of Object.entries(input.current)) {
    const instanceId = ProviderInstanceId.make(rawId);
    const owner = ownerProfile(existing);
    if (owner === undefined || input.desired.has(instanceId)) continue;
    if (input.unavailableProfiles.has(owner) || existing.enabled === false) continue;
    mutations.push({
      operation: "upsert",
      instanceId,
      instance: {
        ...existing,
        enabled: false,
        config: { ...(existing.config as Record<string, unknown>), aixDisabledBySync: true },
      },
    });
  }

  for (const [instanceId, want] of input.desired) {
    const existing = input.current[instanceId];
    if (existing === undefined) {
      mutations.push({ operation: "create", instanceId, instance: want });
      continue;
    }
    // A manual instance with the same id belongs to the user; leave it alone.
    if (ownerProfile(existing) !== ownerProfile(want)) continue;
    const nextEnabled = wasDisabledBySync(existing) ? want.enabled : existing.enabled;
    const next = {
      ...want,
      ...(existing.accentColor === undefined ? {} : { accentColor: existing.accentColor }),
      ...(nextEnabled === undefined ? {} : { enabled: nextEnabled }),
      config: withoutSyncDisabledMarker(want.config),
    };
    if (sameOwnedFields(existing, next) && !wasDisabledBySync(existing)) continue;
    mutations.push({ operation: "upsert", instanceId, instance: next });
  }

  return mutations;
}

/** Process-boundary seam: production shells out to aix; tests inject fakes. */
export interface AixSyncSource {
  readonly listProfiles: Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly label: string }>,
    AixDiscovery.AixDiscoveryError
  >;
  readonly resolveEnvironment: (
    profileName: string,
  ) => Effect.Effect<AixDiscovery.ResolvedEnvironment, AixDiscovery.AixDiscoveryError>;
  readonly listModels: (
    profileName: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string }>, AixDiscovery.AixDiscoveryError>;
  readonly listCatalog: (
    profileName: string,
    refresh: boolean,
  ) => Effect.Effect<ReadonlyArray<AixDiscovery.AixCatalogModel>, AixDiscovery.AixDiscoveryError>;
}

const observeProfile = Effect.fn("AixProviderInstanceSync.observeProfile")(function* (
  source: AixSyncSource,
  profile: { readonly name: string },
  environment: AixDiscovery.ResolvedEnvironment,
  refresh: boolean,
) {
  if (environment.endpointKind === "anthropic") {
    return routeAixModels("anthropic", catalogModels(yield* source.listModels(profile.name)));
  }
  // Only a successful LiteLLM catalog read classifies the endpoint; an unknown one is never assumed.
  return routeAixModels("litellm", catalogModels(yield* source.listCatalog(profile.name, refresh)));
});

type AixProfileListing = ReadonlyArray<{ readonly name: string; readonly label: string }>;

export interface AixSyncCache {
  readonly profiles: AixCatalogCache.CatalogCache<AixProfileListing>;
  readonly routes: AixCatalogCache.CatalogCache<AixObservedProfile["routes"]>;
  readonly staleByProfile: Ref.Ref<ReadonlyMap<string, AixCatalogCache.StaleMarker>>;
  readonly routeKeys: Ref.Ref<ReadonlyMap<string, string>>;
  readonly syncLock: Semaphore.Semaphore;
}

export const withAixCatalogStatus = (
  provider: ServerProvider,
  stale: AixCatalogCache.StaleMarker | undefined,
): ServerProvider => {
  if (stale === undefined || provider.status === "disabled") return provider;
  const note = `aix catalog stale since ${DateTime.formatIso(DateTime.makeUnsafe(stale.since))} (${stale.code}).`;
  return {
    ...provider,
    status: provider.status === "ready" ? "warning" : provider.status,
    message: provider.message === undefined ? note : `${provider.message} ${note}`,
  };
};

export const makeAixSyncCache: Effect.Effect<AixSyncCache> = Effect.gen(function* () {
  return {
    profiles: yield* AixCatalogCache.make<AixProfileListing>(),
    routes: yield* AixCatalogCache.make<AixObservedProfile["routes"]>(),
    staleByProfile: yield* Ref.make<ReadonlyMap<string, AixCatalogCache.StaleMarker>>(new Map()),
    routeKeys: yield* Ref.make<ReadonlyMap<string, string>>(new Map()),
    syncLock: yield* Semaphore.make(1),
  };
});

const routeCacheKey = Effect.fn("AixProviderInstanceSync.routeCacheKey")(function* (
  profileName: string,
  environment: AixDiscovery.ResolvedEnvironment,
  digest: Digest.Digest["Service"],
) {
  const fingerprint = yield* digest.digest(
    Digest.sha256,
    new TextEncoder().encode(
      [environment.endpointKind, environment.endpoint, environment.apiKey]
        .map((value) => `${value.length}:${value}`)
        .join(""),
    ),
  );
  return `${profileName}\0${Hex.encode(fingerprint)}`;
});

/** Only the reason: aix error output can echo credentials. */
const failureCode = (error: AixDiscovery.AixDiscoveryError) => error.reason;

/**
 * Reconciles managed aix instances with settings. Writes only what differs. When aix is off, it
 * disables managed instances and leaves original providers alone. Reads go through `cache`, so a
 * refresh inside the catalog TTL reaches aix only when `force` is set.
 */
export const syncAixProviderInstances = Effect.fn("AixProviderInstanceSync.sync")(
  function* (input: {
    readonly enabled: boolean;
    readonly source: AixSyncSource;
    readonly cache?: AixSyncCache;
    readonly force?: boolean;
    readonly onStatusChange?: (profile: string) => Effect.Effect<void>;
  }) {
    const settings = yield* ServerSettingsService;
    const cache = input.cache ?? (yield* makeAixSyncCache);
    yield* cache.syncLock.withPermits(1)(
      Effect.gen(function* () {
        const force = input.force === true;
        const unavailableProfiles = new Set<string>();
        const observedProfiles: Array<AixObservedProfile> = [];

        if (input.enabled) {
          const listing = yield* cache.profiles
            .read("profiles", input.source.listProfiles, { force, failureCode })
            .pipe(Effect.result);
          if (Result.isFailure(listing)) {
            yield* Effect.logWarning(
              "aix profile listing failed; provider instances left unchanged",
            );
            return;
          }
          if (listing.success.stale !== undefined) {
            yield* Effect.logWarning(
              `aix profile listing stale (${listing.success.stale.code}); using the last valid list`,
            );
          }
          const digest = yield* Digest.Digest;
          const listedProfiles = new Set(listing.success.value.map(({ name }) => name));
          yield* cache.routes.retain((key) =>
            [...listedProfiles].some((profileName) => key.startsWith(`${profileName}\0`)),
          );
          const previousRouteKeys = yield* Ref.get(cache.routeKeys);
          yield* Ref.set(
            cache.routeKeys,
            new Map(
              [...previousRouteKeys].filter(([profileName]) => listedProfiles.has(profileName)),
            ),
          );
          const staleByProfile = new Map<string, AixCatalogCache.StaleMarker>();
          for (const profile of listing.success.value) {
            const environment = yield* input.source
              .resolveEnvironment(profile.name)
              .pipe(Effect.result);
            if (Result.isFailure(environment)) {
              unavailableProfiles.add(profile.name);
              const previousKey = previousRouteKeys.get(profile.name);
              if (previousKey !== undefined) {
                const routes = yield* cache.routes
                  .read(previousKey, Effect.fail(environment.failure), {
                    force: true,
                    failureCode,
                  })
                  .pipe(Effect.result);
                if (Result.isSuccess(routes) && routes.success.stale !== undefined) {
                  staleByProfile.set(profile.name, routes.success.stale);
                }
              }
              continue;
            }
            const key = yield* routeCacheKey(profile.name, environment.success, digest);
            const previousKey = previousRouteKeys.get(profile.name);
            const routes = yield* cache.routes
              .read(key, observeProfile(input.source, profile, environment.success, force), {
                force,
                failureCode,
                ...(previousKey !== undefined && previousKey !== key
                  ? { fallbackKey: previousKey }
                  : {}),
              })
              .pipe(Effect.result);
            if (Result.isFailure(routes)) {
              unavailableProfiles.add(profile.name);
              yield* Effect.logWarning(
                `aix profile ${profile.name} unavailable; its provider instances left unchanged`,
              );
              continue;
            }
            yield* Ref.update(cache.routeKeys, (keys) => new Map(keys).set(profile.name, key));
            yield* cache.routes.retain(
              (candidate) => !candidate.startsWith(`${profile.name}\0`) || candidate === key,
            );
            if (routes.success.stale !== undefined) {
              yield* Effect.logWarning(
                `aix profile ${profile.name} catalog stale (${routes.success.stale.code}); using the last valid catalog`,
              );
            }
            const stale = listing.success.stale ?? routes.success.stale;
            if (stale !== undefined) staleByProfile.set(profile.name, stale);
            observedProfiles.push({
              name: profile.name,
              label: profile.label,
              routes: routes.success.value,
            });
          }
          // Commit and publish together: an interrupt between them would hide the change from later diffs.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const previous = yield* Ref.getAndSet(cache.staleByProfile, staleByProfile);
              if (input.onStatusChange === undefined) return;
              for (const profile of new Set([...previous.keys(), ...staleByProfile.keys()])) {
                const before = previous.get(profile);
                const after = staleByProfile.get(profile);
                if (before?.since !== after?.since || before?.code !== after?.code) {
                  yield* input.onStatusChange(profile);
                }
              }
            }),
          );
        }

        const desired = aixDesiredInstances(observedProfiles);
        const plan = (current: ProviderInstanceConfigMap) =>
          planAixInstanceSync({ current, desired, unavailableProfiles });
        // The snapshot only skips a no-op write; the plan reruns under the settings lock so a
        // concurrent user toggle is never overwritten.
        if (plan((yield* settings.getSettings).providerInstances).length === 0) return;
        yield* settings
          .updateProviderInstances(plan)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("aix provider instances not saved", cause),
            ),
          );
      }),
    );
  },
);

const liveSource = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return {
    listProfiles: AixDiscovery.listProfiles().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
    resolveEnvironment: (profileName) =>
      AixDiscovery.resolveEnvironment(profileName).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    listModels: (profileName) =>
      AixDiscovery.listModels(profileName).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    listCatalog: (profileName, refresh) =>
      AixDiscovery.listCatalog(profileName, refresh).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
  } satisfies AixSyncSource;
});

/** Gate: aix profiles are listed only when the host opts in with `T3CODE_AIX=1`. */
export const syncAixFromEnvironment = Effect.fn("AixProviderInstanceSync.syncFromEnvironment")(
  function* (
    environment: Readonly<Record<string, string | undefined>>,
    source: AixSyncSource,
    options: {
      readonly cache?: AixSyncCache;
      readonly force?: boolean;
      readonly onStatusChange?: (profile: string) => Effect.Effect<void>;
    } = {},
  ) {
    yield* syncAixProviderInstances({
      enabled: environment[AIX_ENABLED_ENVIRONMENT_VARIABLE] === "1",
      source,
      ...options,
    });
  },
);

const allAixCatalogsExpired = Effect.fn("AixProviderInstanceSync.allCatalogsExpired")(function* (
  cache: AixSyncCache,
) {
  if (!(yield* cache.profiles.isExpired("profiles"))) return false;
  for (const key of (yield* Ref.get(cache.routeKeys)).values()) {
    if (!(yield* cache.routes.isExpired(key))) return false;
  }
  return true;
});

export const runAixCatalogRefreshLoop = (input: {
  readonly cache: AixSyncCache;
  readonly shouldRunScopeWork: Effect.Effect<boolean>;
  readonly refresh: (input: { readonly force: boolean }) => Effect.Effect<void>;
}) =>
  Effect.forever(
    Effect.sleep(Duration.hours(1)).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if (!(yield* input.shouldRunScopeWork)) return;
          if (!(yield* allAixCatalogsExpired(input.cache))) return;
          yield* input.refresh({ force: true });
        }),
      ),
      Effect.ignoreCause({ log: true }),
    ),
  );

export class AixProviderInstanceSync extends Context.Service<
  AixProviderInstanceSync,
  {
    /** `force` bypasses the catalog TTL; explicit user refreshes set it. */
    readonly refresh: (input: { readonly force: boolean }) => Effect.Effect<void>;
    readonly getProfileStatus: (
      profileName: string,
    ) => Effect.Effect<AixCatalogCache.StaleMarker | undefined>;
    readonly streamProfileStatusChanges: Stream.Stream<string>;
  }
>()("t3/aix/ProviderInstanceSync/AixProviderInstanceSync") {}

export const getAixProfileStatus = (profileName: string) =>
  Effect.serviceOption(AixProviderInstanceSync).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.flatMap((service) =>
      service === undefined ? Effect.undefined : service.getProfileStatus(profileName),
    ),
  );

export const streamAixProfileStatusChanges = (profileName: string) =>
  Effect.serviceOption(AixProviderInstanceSync).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.map((service) =>
      service === undefined
        ? Stream.empty
        : service.streamProfileStatusChanges.pipe(Stream.filter((name) => name === profileName)),
    ),
  );

const make = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const settings = yield* ServerSettingsService;
  const digest = yield* Digest.Digest;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const source = yield* liveSource;
  const cache = yield* makeAixSyncCache;
  const profileStatusChanges = yield* PubSub.unbounded<string>();

  const refresh = Effect.fn("AixProviderInstanceSync.refresh")(function* (input: {
    readonly force: boolean;
  }) {
    yield* syncAixFromEnvironment(environment, source, {
      cache,
      force: input.force,
      onStatusChange: (profile) =>
        PubSub.publish(profileStatusChanges, profile).pipe(Effect.asVoid),
    }).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.catchCause((cause) => Effect.logError("aix provider instance sync failed", cause)),
      Effect.provideService(ServerSettingsService, settings),
    );
  });

  yield* refresh({ force: false }).pipe(Effect.forkScoped);
  yield* runAixCatalogRefreshLoop({
    cache,
    shouldRunScopeWork: backgroundPolicy.shouldRunScopeWork({ type: "provider-status" }),
    refresh,
  }).pipe(Effect.forkScoped);

  return AixProviderInstanceSync.of({
    refresh,
    getProfileStatus: Effect.fn("AixProviderInstanceSync.getProfileStatus")(
      function* (profileName) {
        return (yield* Ref.get(cache.staleByProfile)).get(profileName);
      },
    ),
    streamProfileStatusChanges: Stream.fromPubSub(profileStatusChanges),
  });
});

export const layer = Layer.effect(AixProviderInstanceSync, make);
