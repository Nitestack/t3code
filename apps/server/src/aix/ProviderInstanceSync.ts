import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceMutation,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as AixDiscovery from "../provider/AixDiscovery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  type CatalogModel,
  type FetchLiteLlmModelCatalogInput,
  fetchLiteLlmModelCatalog,
  ModelCatalogFetchError,
  normalizeModelInfo,
} from "./ModelCatalog.ts";
import { type AixModelRoute, routeCatalogModel } from "./ModelRouting.ts";

/** Set to `1` on the server host to let aix profiles create provider instances. */
const AIX_ENABLED_ENVIRONMENT_VARIABLE = "T3CODE_AIX";
/** Read by the Codex and Claude drivers at launch. OpenCode does not read it, so it is excluded. */
const AIX_PROFILE_VARIABLE = "T3_AIX_PROFILE";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE_CODE = ProviderDriverKind.make("claudeAgent");
const SUPPORTED_DRIVERS: ReadonlyArray<ProviderDriverKind> = [CODEX, CLAUDE_CODE];

export interface AixRoutedModel {
  readonly id: string;
  readonly displayName: string;
}

export type AixRouteSource = "anthropic" | "litellm";

const routeFor = (source: AixRouteSource, modelId: string): AixModelRoute => {
  if (source === "anthropic") return "anthropic-direct-messages";
  if (modelId.startsWith("claude-")) return "litellm-anthropic-messages";
  if (modelId.startsWith("gpt-")) return "litellm-openai-responses";
  return "litellm-openai-chat";
};

/** Routes each model only through a verified pair; an unverified pair is dropped, never substituted. */
export function routeAixModels(
  source: AixRouteSource,
  models: ReadonlyArray<CatalogModel>,
): ReadonlyMap<ProviderDriverKind, ReadonlyArray<AixRoutedModel>> {
  const routes = new Map<ProviderDriverKind, Array<AixRoutedModel>>();
  for (const model of models) {
    const routing = routeCatalogModel(model, { route: routeFor(source, model.id) });
    if (routing.kind !== "routed" || !SUPPORTED_DRIVERS.includes(routing.driverKind)) continue;
    const driverModels = routes.get(routing.driverKind) ?? [];
    driverModels.push({ id: model.id, displayName: model.displayName });
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

const driverLabel = (driver: ProviderDriverKind) => (driver === CODEX ? "Codex" : "Claude Code");

export function aixDesiredInstances(
  profiles: ReadonlyArray<AixObservedProfile>,
): Map<ProviderInstanceId, ProviderInstanceConfig> {
  const desired = new Map<ProviderInstanceId, ProviderInstanceConfig>();
  for (const profile of profiles) {
    for (const [driver, models] of profile.routes) {
      const instanceId = aixInstanceId(driver, profile.name);
      if (instanceId === undefined || models.length === 0) continue;
      desired.set(instanceId, {
        driver,
        displayName: `${profile.label} · ${driverLabel(driver)}`,
        enabled: true,
        environment: [{ name: AIX_PROFILE_VARIABLE, value: profile.name, sensitive: false }],
        config: {
          aixProfile: profile.name,
          customModels: models.map((model) => ({ slug: model.id, name: model.displayName })),
        },
      });
    }
  }
  return desired;
}

const sameOwnedFields = (left: ProviderInstanceConfig, right: ProviderInstanceConfig) =>
  NodeUtil.isDeepStrictEqual(
    {
      driver: left.driver,
      displayName: left.displayName,
      enabled: left.enabled,
      environment: left.environment,
      config: left.config,
    },
    {
      driver: right.driver,
      displayName: right.displayName,
      enabled: right.enabled,
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
    mutations.push({ operation: "upsert", instanceId, instance: { ...existing, enabled: false } });
  }

  for (const [instanceId, want] of input.desired) {
    const existing = input.current[instanceId];
    if (existing === undefined) {
      mutations.push({ operation: "create", instanceId, instance: want });
      continue;
    }
    // A manual instance with the same id belongs to the user; leave it alone.
    if (ownerProfile(existing) !== ownerProfile(want) || sameOwnedFields(existing, want)) continue;
    mutations.push({ operation: "upsert", instanceId, instance: want });
  }

  return mutations;
}

/** Process-boundary seam: production wires aix and LiteLLM; tests inject fakes. */
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
  readonly fetchLiteLlmCatalog: (
    input: FetchLiteLlmModelCatalogInput,
  ) => Effect.Effect<{ readonly models: ReadonlyArray<CatalogModel> }, ModelCatalogFetchError>;
}

const litellmApiBaseUrl = (endpoint: string) => `${endpoint.replace(/\/+$/u, "")}/v1`;

const observeProfile = Effect.fn("AixProviderInstanceSync.observeProfile")(function* (
  source: AixSyncSource,
  profile: { readonly name: string },
) {
  const environment = yield* source.resolveEnvironment(profile.name);
  if (environment.endpointKind === "anthropic") {
    const listed = yield* source.listModels(profile.name);
    return routeAixModels(
      "anthropic",
      normalizeModelInfo(
        [],
        undefined,
        listed.map((model) => model.id),
      ),
    );
  }
  // Only a successful LiteLLM catalog read classifies the endpoint; an unknown one is never assumed.
  const catalog = yield* source.fetchLiteLlmCatalog({
    baseURL: litellmApiBaseUrl(environment.endpoint),
    apiKey: environment.apiKey,
  });
  return routeAixModels("litellm", catalog.models);
});

/**
 * Reconciles managed aix instances with settings. Writes only what differs. When aix is off, it
 * disables managed instances and leaves original providers alone.
 */
export const syncAixProviderInstances = Effect.fn("AixProviderInstanceSync.sync")(
  function* (input: { readonly enabled: boolean; readonly source: AixSyncSource }) {
    const settings = yield* ServerSettingsService;
    const unavailableProfiles = new Set<string>();
    const observedProfiles: Array<AixObservedProfile> = [];

    if (input.enabled) {
      const listing = yield* input.source.listProfiles.pipe(Effect.result);
      if (Result.isFailure(listing)) {
        yield* Effect.logWarning("aix profile listing failed; provider instances left unchanged");
        return;
      }
      for (const profile of listing.success) {
        const routes = yield* observeProfile(input.source, profile).pipe(Effect.result);
        if (Result.isFailure(routes)) {
          unavailableProfiles.add(profile.name);
          yield* Effect.logWarning(
            `aix profile ${profile.name} unavailable; its provider instances left unchanged`,
          );
          continue;
        }
        observedProfiles.push({ name: profile.name, label: profile.label, routes: routes.success });
      }
    }

    // Read after the slow aix and catalog calls, so a manual instance that appeared meanwhile is seen.
    const current = (yield* settings.getSettings).providerInstances;
    const mutations = planAixInstanceSync({
      current,
      desired: aixDesiredInstances(observedProfiles),
      unavailableProfiles,
    });
    for (const mutation of mutations) {
      yield* settings
        .updateProviderInstance(mutation)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`aix provider instance ${mutation.instanceId} not saved`, cause),
          ),
        );
    }
  },
);

const liveSource = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
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
    fetchLiteLlmCatalog: (input) =>
      fetchLiteLlmModelCatalog(input).pipe(Effect.provideService(HttpClient.HttpClient, http)),
  } satisfies AixSyncSource;
});

/** Startup gate: aix profiles are listed only when the host opts in with `T3CODE_AIX=1`. */
export const syncAixOnStartup = Effect.fn("AixProviderInstanceSync.syncOnStartup")(function* (
  environment: Readonly<Record<string, string | undefined>>,
  source: AixSyncSource,
) {
  yield* syncAixProviderInstances({
    enabled: environment[AIX_ENABLED_ENVIRONMENT_VARIABLE] === "1",
    source,
  });
});

/** Syncs once at startup in the background; a later refresh should call the same effect. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    const source = yield* liveSource;
    yield* syncAixOnStartup(environment, source).pipe(
      Effect.catchCause((cause) => Effect.logError("aix provider instance sync failed", cause)),
      Effect.forkScoped,
    );
  }),
);
