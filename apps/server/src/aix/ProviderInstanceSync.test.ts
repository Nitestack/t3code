import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import { AixDiscoveryError } from "../provider/AixDiscovery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { type CatalogModel, ModelCatalogFetchError } from "./ModelCatalog.ts";
import {
  type AixSyncCache,
  type AixSyncSource,
  aixDesiredInstances,
  aixInstanceId,
  makeAixSyncCache,
  planAixInstanceSync,
  routeAixModels,
  runAixCatalogRefreshLoop,
  syncAixFromEnvironment,
  syncAixProviderInstances,
  withAixCatalogStatus,
} from "./ProviderInstanceSync.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE_CODE = ProviderDriverKind.make("claudeAgent");
const OPENCODE = ProviderDriverKind.make("opencode");
const SENTINEL_KEY = "sk-aix-sentinel-do-not-persist";
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const aixTestLayer = Layer.mergeAll(ServerSettingsService.layerTest(), Digest.layerWebCrypto);

const LITELLM_MODELS: ReadonlyArray<CatalogModel> = [
  { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
  { id: "gpt-oss-120b", displayName: "GPT-OSS 120B" },
  { id: "google/gemma-4-31b-it", displayName: "Gemma 4 31B IT" },
  { id: "text-embedding-3-large", displayName: "Text Embedding 3 Large" },
];

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("fixture missing");
  return value;
};

const desiredFor = (profile: string, label = "Work") =>
  aixDesiredInstances([
    { name: profile, label, routes: routeAixModels("litellm", LITELLM_MODELS) },
  ]);

const codexInstance = (profile: string) =>
  must(desiredFor(profile).get(must(aixInstanceId(CODEX, profile))));

const manualCodex = (): ProviderInstanceConfig => ({
  driver: CODEX,
  displayName: "My Codex",
  enabled: true,
});

describe("routeAixModels", () => {
  it("routes only verified pairs and never produces an OpenCode-backed instance", () => {
    const routes = routeAixModels("litellm", LITELLM_MODELS);

    expect(routes.get(CODEX)?.map((model) => model.id)).toEqual(["gpt-6.1-sol"]);
    expect(routes.has(CLAUDE_CODE)).toBe(false);
    expect(routes.has(OPENCODE)).toBe(false);
  });

  it("allows only the verified native Claude model on a direct Anthropic endpoint", () => {
    const routes = routeAixModels("anthropic", [
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
      { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
    ]);

    expect([...routes.keys()]).toEqual([CLAUDE_CODE]);
    expect(routes.get(CLAUDE_CODE)?.map((model) => model.id)).toEqual(["claude-opus-5-5"]);
  });
});

describe("aixDesiredInstances", () => {
  it("carries catalog metadata through the managed custom-model config", () => {
    const desired = aixDesiredInstances([
      {
        name: "work",
        label: "Work",
        routes: routeAixModels("litellm", [
          {
            id: "gpt-6.1-sol",
            displayName: "Readable Model",
            family: "Vendor Family",
            contextTokens: 128_000,
            maxOutputTokens: 16_000,
            pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 8 },
            reasoning: { efforts: ["low", "high"] },
          },
        ]),
      },
    ]);
    const config = must(desired.get(ProviderInstanceId.make("aix-codex-work")))?.config;

    expect(decodeCodexSettings(config).customModels).toEqual([
      {
        slug: "gpt-6.1-sol",
        name: "Readable Model",
        catalogMetadata: {
          family: "Vendor Family",
          contextTokens: 128_000,
          maxOutputTokens: 16_000,
          pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 8 },
          reasoning: { efforts: ["low", "high"] },
        },
      },
    ]);
  });

  it("gives two profiles distinct, deterministic instances whose configs match the driver schemas", () => {
    const desired = aixDesiredInstances([
      { name: "work", label: "Work", routes: routeAixModels("litellm", LITELLM_MODELS) },
      {
        name: "claude",
        label: "Claude",
        routes: routeAixModels("anthropic", [{ id: "claude-opus-5-5", displayName: "Opus" }]),
      },
    ]);

    expect([...desired.keys()]).toEqual(["aix-codex-work", "aix-claudeAgent-claude"]);
    const codex = must(desired.get(ProviderInstanceId.make("aix-codex-work")));
    expect(codex).toMatchObject({
      driver: CODEX,
      displayName: "Work · Codex",
      enabled: true,
      environment: [{ name: "T3_AIX_PROFILE", value: "work", sensitive: false }],
      config: { aixProfile: "work", customModels: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] },
    });
    expect(decodeCodexSettings(codex.config).customModels).toHaveLength(1);
    expect(
      decodeClaudeSettings(
        must(desired.get(ProviderInstanceId.make("aix-claudeAgent-claude")))?.config,
      ).customModels,
    ).toHaveLength(1);
  });

  it("skips a profile name that cannot form a valid instance id", () => {
    expect(desiredFor("1 bad name").size).toBe(0);
  });
});

describe("withAixCatalogStatus", () => {
  it("downgrades ready to warning with a secret-free refresh note", () => {
    const provider = { status: "ready", message: undefined } as never;

    expect(withAixCatalogStatus(provider, { since: 0, code: "request-503" })).toMatchObject({
      status: "warning",
      message: "aix catalog stale since 1970-01-01T00:00:00.000Z (request-503).",
    });
  });

  it("keeps errors and appends the stale note to their message", () => {
    expect(
      withAixCatalogStatus({ status: "error", message: "Codex binary is missing" } as never, {
        since: 0,
        code: "request-503",
      }),
    ).toMatchObject({
      status: "error",
      message:
        "Codex binary is missing aix catalog stale since 1970-01-01T00:00:00.000Z (request-503).",
    });
  });

  it("keeps warnings and appends the stale note to their message", () => {
    expect(
      withAixCatalogStatus(
        { status: "warning", message: "Authentication needs attention" } as never,
        { since: 0, code: "request-503" },
      ),
    ).toMatchObject({
      status: "warning",
      message:
        "Authentication needs attention aix catalog stale since 1970-01-01T00:00:00.000Z (request-503).",
    });
  });

  it("leaves disabled providers untouched", () => {
    const provider = { status: "disabled", message: "Provider disabled" } as never;
    expect(withAixCatalogStatus(provider, { since: 0, code: "request-503" })).toBe(provider);
  });
});

describe("planAixInstanceSync", () => {
  const work = desiredFor("work");

  it("creates each desired instance once and plans nothing on the next refresh", () => {
    const first = planAixInstanceSync({
      current: {} as ProviderInstanceConfigMap,
      desired: work,
      unavailableProfiles: new Set(),
    });
    expect(first.map((mutation) => [mutation.operation, mutation.instanceId])).toEqual([
      ["create", "aix-codex-work"],
    ]);

    const current = Object.fromEntries(work) as ProviderInstanceConfigMap;
    expect(planAixInstanceSync({ current, desired: work, unavailableProfiles: new Set() })).toEqual(
      [],
    );
  });

  it("never overwrites a manual instance that uses the same id", () => {
    const current = {
      [ProviderInstanceId.make("aix-codex-work")]: manualCodex(),
    } as ProviderInstanceConfigMap;

    expect(planAixInstanceSync({ current, desired: work, unavailableProfiles: new Set() })).toEqual(
      [],
    );
  });

  it("disables only managed instances of a removed profile and keeps manual and default ones", () => {
    const current = {
      [ProviderInstanceId.make("codex")]: { driver: CODEX },
      [ProviderInstanceId.make("aix-codex-old")]: codexInstance("old"),
      [ProviderInstanceId.make("codex_work")]: manualCodex(),
    } as ProviderInstanceConfigMap;

    const mutations = planAixInstanceSync({
      current,
      desired: new Map(),
      unavailableProfiles: new Set(),
    });

    expect(mutations).toEqual([
      {
        operation: "upsert",
        instanceId: ProviderInstanceId.make("aix-codex-old"),
        instance: { ...codexInstance("old"), enabled: false },
      },
    ]);
  });

  it("leaves managed instances unchanged while their profile is unavailable", () => {
    const current = {
      [ProviderInstanceId.make("aix-codex-work")]: codexInstance("work"),
    } as ProviderInstanceConfigMap;

    expect(
      planAixInstanceSync({
        current,
        desired: new Map(),
        unavailableProfiles: new Set(["work"]),
      }),
    ).toEqual([]);
  });

  it("disables managed instances when aix is off and leaves original providers alone", () => {
    const current = {
      [ProviderInstanceId.make("codex")]: { driver: CODEX },
      [ProviderInstanceId.make("aix-codex-work")]: codexInstance("work"),
    } as ProviderInstanceConfigMap;

    const mutations = planAixInstanceSync({
      current,
      desired: new Map(),
      unavailableProfiles: new Set(),
    });

    expect(mutations).toEqual([
      {
        operation: "upsert",
        instanceId: ProviderInstanceId.make("aix-codex-work"),
        instance: { ...codexInstance("work"), enabled: false },
      },
    ]);
  });

  it("re-enables a disabled managed instance when its profile returns", () => {
    const current = {
      [ProviderInstanceId.make("aix-codex-work")]: { ...codexInstance("work"), enabled: false },
    } as ProviderInstanceConfigMap;

    expect(planAixInstanceSync({ current, desired: work, unavailableProfiles: new Set() })).toEqual(
      [
        {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("aix-codex-work"),
          instance: codexInstance("work"),
        },
      ],
    );
  });
});

describe("syncAixProviderInstances", () => {
  const sourceFor = (overrides: Partial<AixSyncSource> = {}): AixSyncSource => ({
    listProfiles: Effect.succeed([
      { name: "work", label: "Work" },
      { name: "claude", label: "Claude" },
    ]),
    resolveEnvironment: (profileName) =>
      Effect.succeed(
        profileName === "claude"
          ? {
              profileName,
              endpoint: "https://api.anthropic.com",
              endpointKind: "anthropic",
              apiKey: SENTINEL_KEY,
            }
          : {
              profileName,
              endpoint: "https://gateway.example",
              endpointKind: "unknown",
              apiKey: SENTINEL_KEY,
            },
      ),
    listModels: () => Effect.succeed([{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }]),
    fetchLiteLlmCatalog: () => Effect.succeed({ models: LITELLM_MODELS }),
    ...overrides,
  });

  // Records writes that reach the real settings store, so a no-op refresh is observable.
  const countingSettings = Effect.gen(function* () {
    const base = yield* ServerSettingsService;
    const writes = yield* Ref.make<ReadonlyArray<string>>([]);
    const payloads = yield* Ref.make<ReadonlyArray<string>>([]);
    const counted = {
      ...base,
      updateProviderInstance: (...args: Parameters<typeof base.updateProviderInstance>) =>
        Ref.update(writes, (previous) => [...previous, args[0].instanceId]).pipe(
          Effect.andThen(
            Ref.update(payloads, (previous) => [...previous, JSON.stringify(args[0])]),
          ),
          Effect.andThen(base.updateProviderInstance(...args)),
        ),
    } satisfies ServerSettingsService["Service"];
    return { counted, writes, payloads };
  });

  effectIt.effect("creates instances for both profiles, and a refresh writes nothing", () =>
    Effect.gen(function* () {
      const { counted, writes } = yield* countingSettings;
      const sync = syncAixProviderInstances({ enabled: true, source: sourceFor() }).pipe(
        Effect.provideService(ServerSettingsService, counted),
      );

      yield* sync;
      const afterFirst = yield* Ref.get(writes);
      yield* sync;

      expect(afterFirst).toEqual(["aix-codex-work", "aix-claudeAgent-claude"]);
      expect(yield* Ref.get(writes)).toEqual(afterFirst);
      const settings = yield* (yield* ServerSettingsService).getSettings;
      expect(Object.keys(settings.providerInstances).sort()).toEqual([
        "aix-claudeAgent-claude",
        "aix-codex-work",
      ]);
    }).pipe(Effect.provide(aixTestLayer)),
  );

  effectIt.effect("does not overlap concurrent profile syncs", () =>
    Effect.gen(function* () {
      const { counted, writes } = yield* countingSettings;
      const cache = yield* makeAixSyncCache;
      const profileReadsStarted = yield* Queue.unbounded<void>();
      const activeReads = yield* Ref.make(0);
      const maxActiveReads = yield* Ref.make(0);
      const base = sourceFor();
      const source = sourceFor({
        listProfiles: Effect.succeed([{ name: "work", label: "Work" }]),
        resolveEnvironment: (profileName) =>
          Effect.gen(function* () {
            const active = yield* Ref.updateAndGet(activeReads, (count) => count + 1);
            yield* Ref.update(maxActiveReads, (maximum) => Math.max(maximum, active));
            yield* Queue.offer(profileReadsStarted, undefined);
            yield* Effect.sleep("1 hour");
            yield* Ref.update(activeReads, (count) => count - 1);
            return yield* base.resolveEnvironment(profileName);
          }),
      });
      const runSync = () =>
        syncAixProviderInstances({ enabled: true, source, cache }).pipe(
          Effect.provideService(ServerSettingsService, counted),
        );
      const concurrent = yield* Effect.forEach([1, 2], runSync, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.forkChild);

      yield* Queue.take(profileReadsStarted);
      yield* TestClock.adjust("1 hour");
      yield* Queue.take(profileReadsStarted);
      yield* TestClock.adjust("1 hour");
      yield* Fiber.join(concurrent);

      expect(yield* Ref.get(maxActiveReads)).toBe(1);
      expect(yield* Ref.get(writes)).toEqual(["aix-codex-work"]);
    }).pipe(Effect.provide(aixTestLayer)),
  );

  effectIt.effect("hourly refresh catches up after provider background work resumes", () =>
    Effect.gen(function* () {
      const cache = yield* makeAixSyncCache;
      const slowLoad = Effect.sleep("2 hours").pipe(Effect.as([{ name: "work", label: "Work" }]));
      const loading = yield* Effect.forkChild(
        cache.profiles.read("profiles", slowLoad, {
          force: false,
          failureCode: () => "catalog-error",
        }),
      );
      yield* TestClock.adjust("2 hours");
      yield* Fiber.join(loading);

      const leaseAvailable = yield* Ref.make(false);
      const refreshes = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const caughtUp = yield* Deferred.make<void>();
      const loop = yield* runAixCatalogRefreshLoop({
        cache,
        shouldRunScopeWork: Ref.get(leaseAvailable),
        refresh: ({ force }) =>
          Ref.update(refreshes, (previous) => [...previous, force]).pipe(
            Effect.tap(() => Deferred.succeed(caughtUp, undefined)),
          ),
      }).pipe(Effect.forkChild);

      yield* TestClock.adjust("23 hours");
      expect(yield* Ref.get(refreshes)).toEqual([]);
      yield* TestClock.adjust("1 hour");
      expect(yield* Ref.get(refreshes)).toEqual([]);

      yield* Ref.set(leaseAvailable, true);
      yield* TestClock.adjust("1 hour");
      yield* Deferred.await(caughtUp);
      expect(yield* Ref.get(refreshes)).toEqual([true]);
      yield* Fiber.interrupt(loop);
    }),
  );

  effectIt.effect("writes nothing when aix cannot list profiles", () =>
    Effect.gen(function* () {
      const { counted, writes } = yield* countingSettings;
      yield* syncAixProviderInstances({
        enabled: true,
        source: sourceFor({
          listProfiles: Effect.fail(new AixDiscoveryError({ reason: "command-failed" })),
        }),
      }).pipe(Effect.provideService(ServerSettingsService, counted));

      expect(yield* Ref.get(writes)).toEqual([]);
    }).pipe(Effect.provide(aixTestLayer)),
  );

  effectIt.effect(
    "keeps a profile's managed instance enabled when its catalog cannot be read",
    () =>
      Effect.gen(function* () {
        const { counted, writes } = yield* countingSettings;
        const sync = (source: AixSyncSource) =>
          syncAixProviderInstances({ enabled: true, source }).pipe(
            Effect.provideService(ServerSettingsService, counted),
          );
        yield* sync(sourceFor());
        yield* Ref.set(writes, []);

        yield* sync(
          sourceFor({
            fetchLiteLlmCatalog: () =>
              Effect.fail(new ModelCatalogFetchError({ stage: "models", reason: "request" })),
          }),
        );

        expect(yield* Ref.get(writes)).toEqual([]);
        const settings = yield* (yield* ServerSettingsService).getSettings;
        expect(settings.providerInstances[ProviderInstanceId.make("aix-codex-work")]?.enabled).toBe(
          true,
        );
      }).pipe(Effect.provide(aixTestLayer)),
  );

  effectIt.effect("uses the resolved key for the catalog request but never persists it", () =>
    Effect.gen(function* () {
      const seenKeys: string[] = [];
      const { counted, payloads } = yield* countingSettings;
      yield* syncAixProviderInstances({
        enabled: true,
        source: sourceFor({
          fetchLiteLlmCatalog: (input) =>
            Effect.sync(() => {
              seenKeys.push(input.apiKey);
              return { models: LITELLM_MODELS };
            }),
        }),
      }).pipe(Effect.provideService(ServerSettingsService, counted));

      const settings = yield* (yield* ServerSettingsService).getSettings;
      expect(seenKeys).toEqual([SENTINEL_KEY]);
      expect((yield* Ref.get(payloads)).length).toBeGreaterThan(0);
      expect(JSON.stringify(settings.providerInstances)).not.toContain(SENTINEL_KEY);
      expect(JSON.stringify(yield* Ref.get(payloads))).not.toContain(SENTINEL_KEY);
    }).pipe(Effect.provide(aixTestLayer)),
  );

  describe("refresh cache", () => {
    const refreshWith = (
      counted: ServerSettingsService["Service"],
      source: AixSyncSource,
      cache: AixSyncCache,
      force = false,
    ) =>
      syncAixProviderInstances({ enabled: true, source, cache, force }).pipe(
        Effect.provideService(ServerSettingsService, counted),
      );

    effectIt.effect("a repeat refresh inside the 24h TTL reads neither aix nor LiteLLM", () =>
      Effect.gen(function* () {
        const { counted } = yield* countingSettings;
        const cache = yield* makeAixSyncCache;
        const profileReads = yield* Ref.make(0);
        const catalogReads = yield* Ref.make(0);
        const base = sourceFor();
        const source = sourceFor({
          listProfiles: Ref.update(profileReads, (count) => count + 1).pipe(
            Effect.andThen(base.listProfiles),
          ),
          fetchLiteLlmCatalog: () =>
            Ref.update(catalogReads, (count) => count + 1).pipe(
              Effect.as({ models: LITELLM_MODELS }),
            ),
        });

        yield* refreshWith(counted, source, cache);
        yield* TestClock.adjust("23 hours");
        yield* refreshWith(counted, source, cache);

        expect(yield* Ref.get(profileReads)).toBe(1);
        expect(yield* Ref.get(catalogReads)).toBe(1);
      }).pipe(Effect.provide(aixTestLayer)),
    );

    effectIt.effect("a refresh after 24h re-reads the profiles and the catalog", () =>
      Effect.gen(function* () {
        const { counted } = yield* countingSettings;
        const cache = yield* makeAixSyncCache;
        const profileReads = yield* Ref.make(0);
        const base = sourceFor();
        const source = sourceFor({
          listProfiles: Ref.update(profileReads, (count) => count + 1).pipe(
            Effect.andThen(base.listProfiles),
          ),
        });

        yield* refreshWith(counted, source, cache);
        yield* TestClock.adjust("24 hours");
        yield* refreshWith(counted, source, cache);

        expect(yield* Ref.get(profileReads)).toBe(2);
      }).pipe(Effect.provide(aixTestLayer)),
    );

    effectIt.effect("a forced refresh reads again inside the TTL", () =>
      Effect.gen(function* () {
        const { counted } = yield* countingSettings;
        const cache = yield* makeAixSyncCache;
        const profileReads = yield* Ref.make(0);
        const base = sourceFor();
        const source = sourceFor({
          listProfiles: Ref.update(profileReads, (count) => count + 1).pipe(
            Effect.andThen(base.listProfiles),
          ),
        });

        yield* refreshWith(counted, source, cache);
        yield* refreshWith(counted, source, cache, true);

        expect(yield* Ref.get(profileReads)).toBe(2);
      }).pipe(Effect.provide(aixTestLayer)),
    );

    effectIt.effect("exposes stale status and clears it after a successful catalog refresh", () =>
      Effect.gen(function* () {
        const { counted } = yield* countingSettings;
        const cache = yield* makeAixSyncCache;
        const source = sourceFor();
        yield* refreshWith(counted, source, cache);
        yield* refreshWith(
          counted,
          sourceFor({
            fetchLiteLlmCatalog: () =>
              Effect.fail(
                new ModelCatalogFetchError({ stage: "models", reason: "request", status: 503 }),
              ),
          }),
          cache,
          true,
        );
        expect((yield* Ref.get(cache.staleByProfile)).get("work")?.code).toBe("request-503");

        yield* refreshWith(counted, source, cache, true);

        expect((yield* Ref.get(cache.staleByProfile)).has("work")).toBe(false);
      }).pipe(Effect.provide(aixTestLayer)),
    );

    effectIt.effect("a gateway 503 on a daily refresh keeps the last valid models", () =>
      Effect.gen(function* () {
        const { counted, writes } = yield* countingSettings;
        const cache = yield* makeAixSyncCache;
        yield* refreshWith(counted, sourceFor(), cache);
        yield* Ref.set(writes, []);

        yield* TestClock.adjust("24 hours");
        yield* refreshWith(
          counted,
          sourceFor({
            fetchLiteLlmCatalog: () =>
              Effect.fail(
                new ModelCatalogFetchError({ stage: "models", reason: "status", status: 503 }),
              ),
          }),
          cache,
        );

        expect(yield* Ref.get(writes)).toEqual([]);
        const settings = yield* (yield* ServerSettingsService).getSettings;
        expect(settings.providerInstances[ProviderInstanceId.make("aix-codex-work")]?.enabled).toBe(
          true,
        );
      }).pipe(Effect.provide(aixTestLayer)),
    );

    effectIt.effect("a forced refresh disables an instance whose only model is deleted", () =>
      Effect.gen(function* () {
        const { counted } = yield* countingSettings;
        const cache = yield* makeAixSyncCache;
        yield* refreshWith(counted, sourceFor(), cache);
        const before = yield* (yield* ServerSettingsService).getSettings;
        expect(before.providerInstances[ProviderInstanceId.make("aix-codex-work")]?.enabled).toBe(
          true,
        );

        yield* refreshWith(
          counted,
          sourceFor({
            fetchLiteLlmCatalog: () =>
              Effect.succeed({
                models: LITELLM_MODELS.filter((model) => model.id !== "gpt-6.1-sol"),
              }),
          }),
          cache,
          true,
        );

        const after = yield* (yield* ServerSettingsService).getSettings;
        expect(after.providerInstances[ProviderInstanceId.make("aix-codex-work")]?.enabled).toBe(
          false,
        );
      }).pipe(Effect.provide(aixTestLayer)),
    );

    effectIt.effect("a forced refresh disables the instance of a profile deleted in aix", () =>
      Effect.gen(function* () {
        const { counted } = yield* countingSettings;
        const cache = yield* makeAixSyncCache;
        yield* refreshWith(counted, sourceFor(), cache);

        yield* refreshWith(
          counted,
          sourceFor({ listProfiles: Effect.succeed([{ name: "claude", label: "Claude" }]) }),
          cache,
          true,
        );

        const settings = yield* (yield* ServerSettingsService).getSettings;
        expect(settings.providerInstances[ProviderInstanceId.make("aix-codex-work")]?.enabled).toBe(
          false,
        );
      }).pipe(Effect.provide(aixTestLayer)),
    );

    effectIt.effect(
      "a forced refresh after key rotation uses the new key and persists neither",
      () =>
        Effect.gen(function* () {
          const rotatedKey = "sk-aix-rotated-do-not-persist";
          const currentKey = yield* Ref.make(SENTINEL_KEY);
          const seenKeys = yield* Ref.make<ReadonlyArray<string>>([]);
          const { counted, payloads } = yield* countingSettings;
          const cache = yield* makeAixSyncCache;
          const source = sourceFor({
            listProfiles: Effect.succeed([{ name: "work", label: "Work" }]),
            resolveEnvironment: (profileName) =>
              Ref.get(currentKey).pipe(
                Effect.map((apiKey) => ({
                  profileName,
                  endpoint: "https://gateway.example",
                  endpointKind: "unknown" as const,
                  apiKey,
                })),
              ),
            fetchLiteLlmCatalog: (input) =>
              Ref.update(seenKeys, (keys) => [...keys, input.apiKey]).pipe(
                Effect.as({ models: LITELLM_MODELS }),
              ),
          });

          yield* refreshWith(counted, source, cache);
          yield* Ref.set(currentKey, rotatedKey);
          yield* refreshWith(counted, source, cache, true);

          expect(yield* Ref.get(seenKeys)).toEqual([SENTINEL_KEY, rotatedKey]);
          const settings = yield* (yield* ServerSettingsService).getSettings;
          expect(JSON.stringify(settings.providerInstances)).not.toContain(rotatedKey);
          expect(JSON.stringify(yield* Ref.get(payloads))).not.toContain(rotatedKey);
        }).pipe(Effect.provide(aixTestLayer)),
    );

    effectIt.effect("re-reads a profile catalog after its key rotates", () =>
      Effect.gen(function* () {
        const { counted } = yield* countingSettings;
        const cache = yield* makeAixSyncCache;
        const keys: Array<string> = [];
        let key = "first-key";
        const base = sourceFor();
        const source = sourceFor({
          resolveEnvironment: (profileName) =>
            base
              .resolveEnvironment(profileName)
              .pipe(Effect.map((environment) => ({ ...environment, apiKey: key }))),
          fetchLiteLlmCatalog: (input) =>
            Effect.sync(() => {
              keys.push(input.apiKey);
              return { models: LITELLM_MODELS };
            }),
        });

        yield* refreshWith(counted, source, cache);
        key = "second-key";
        yield* refreshWith(counted, source, cache);

        expect(keys).toEqual(["first-key", "second-key"]);
      }).pipe(Effect.provide(aixTestLayer)),
    );

    effectIt.effect("keeps the previous catalog stale when a rotated key cannot load", () =>
      Effect.gen(function* () {
        const { counted } = yield* countingSettings;
        const cache = yield* makeAixSyncCache;
        let key = "first-key";
        const base = sourceFor();
        const source = sourceFor({
          resolveEnvironment: (profileName) =>
            base
              .resolveEnvironment(profileName)
              .pipe(Effect.map((environment) => ({ ...environment, apiKey: key }))),
          fetchLiteLlmCatalog: () =>
            key === "first-key"
              ? Effect.succeed({ models: LITELLM_MODELS })
              : Effect.fail(
                  new ModelCatalogFetchError({ stage: "models", reason: "request", status: 503 }),
                ),
        });

        yield* refreshWith(counted, source, cache);
        key = "rotated-key";
        yield* refreshWith(counted, source, cache);

        const settings = yield* (yield* ServerSettingsService).getSettings;
        expect(
          settings.providerInstances[ProviderInstanceId.make("aix-codex-work")]?.config,
        ).toMatchObject({ customModels: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] });
        expect((yield* Ref.get(cache.staleByProfile)).get("work")?.code).toBe("request-503");
      }).pipe(Effect.provide(aixTestLayer)),
    );
  });

  describe("ownership across settings persistence", () => {
    const decodePersisted = Schema.decodeUnknownSync(ProviderInstanceConfigMap);
    const encodePersisted = Schema.encodeSync(ProviderInstanceConfigMap);

    it("keeps the aix marker through an encode and decode of persisted instances", () => {
      const persisted = decodePersisted(
        encodePersisted(decodePersisted({ "aix-codex-work": codexInstance("work") })),
      );

      expect(must(persisted[ProviderInstanceId.make("aix-codex-work")]).config).toEqual(
        codexInstance("work").config,
      );
      expect(
        planAixInstanceSync({
          current: persisted,
          desired: new Map(),
          unavailableProfiles: new Set(),
        }),
      ).toEqual([
        {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("aix-codex-work"),
          instance: { ...codexInstance("work"), enabled: false },
        },
      ]);
    });

    it("keeps the marker in the config each driver decodes from persisted settings", () => {
      const claudeInstance = must(
        aixDesiredInstances([
          {
            name: "claude",
            label: "Claude",
            routes: routeAixModels("anthropic", [{ id: "claude-opus-5-5", displayName: "Opus" }]),
          },
        ]).get(ProviderInstanceId.make("aix-claudeAgent-claude")),
      );
      const persisted = decodePersisted(
        encodePersisted(
          decodePersisted({
            "aix-codex-work": codexInstance("work"),
            "aix-claudeAgent-claude": claudeInstance,
          }),
        ),
      );

      expect(
        decodeCodexSettings(must(persisted[ProviderInstanceId.make("aix-codex-work")]).config)
          .aixProfile,
      ).toBe("work");
      expect(
        decodeClaudeSettings(
          must(persisted[ProviderInstanceId.make("aix-claudeAgent-claude")]).config,
        ).aixProfile,
      ).toBe("claude");
    });
  });

  effectIt.effect(
    "leaves a manual instance that takes a managed id during the catalog read unchanged",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const id = ProviderInstanceId.make("aix-codex-work");
        yield* settings.updateProviderInstance({
          operation: "create",
          instanceId: id,
          instance: { ...codexInstance("work"), displayName: "Stale" },
        });

        yield* syncAixProviderInstances({
          enabled: true,
          source: sourceFor({
            fetchLiteLlmCatalog: () =>
              settings
                .updateProviderInstance({
                  operation: "upsert",
                  instanceId: id,
                  instance: manualCodex(),
                })
                .pipe(Effect.orDie, Effect.as({ models: LITELLM_MODELS })),
          }),
        });

        expect((yield* settings.getSettings).providerInstances[id]).toMatchObject({
          displayName: "My Codex",
        });
      }).pipe(Effect.provide(aixTestLayer)),
  );

  effectIt.effect("reads aix profiles at startup only when T3CODE_AIX is 1", () =>
    Effect.gen(function* () {
      const listings = yield* Ref.make(0);
      const source = sourceFor({
        listProfiles: Ref.update(listings, (count) => count + 1).pipe(Effect.as([])),
      });

      yield* syncAixFromEnvironment({}, source);
      expect(yield* Ref.get(listings)).toBe(0);

      yield* syncAixFromEnvironment({ T3CODE_AIX: "1" }, source);
      expect(yield* Ref.get(listings)).toBe(1);
    }).pipe(Effect.provide(aixTestLayer)),
  );

  effectIt.effect("with aix off and no managed instance, writes nothing", () =>
    Effect.gen(function* () {
      const { counted, writes } = yield* countingSettings;
      yield* syncAixProviderInstances({ enabled: false, source: sourceFor() }).pipe(
        Effect.provideService(ServerSettingsService, counted),
      );

      expect(yield* Ref.get(writes)).toEqual([]);
    }).pipe(Effect.provide(aixTestLayer)),
  );
});
