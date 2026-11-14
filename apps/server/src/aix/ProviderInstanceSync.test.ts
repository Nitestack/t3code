import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AixDiscoveryError } from "../provider/AixDiscovery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { type CatalogModel, ModelCatalogFetchError } from "./ModelCatalog.ts";
import {
  type AixSyncSource,
  aixDesiredInstances,
  aixInstanceId,
  planAixInstanceSync,
  routeAixModels,
  syncAixProviderInstances,
} from "./ProviderInstanceSync.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE_CODE = ProviderDriverKind.make("claudeAgent");
const OPENCODE = ProviderDriverKind.make("opencode");
const SENTINEL_KEY = "sk-aix-sentinel-do-not-persist";
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

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
    const counted = {
      ...base,
      updateProviderInstance: (...args: Parameters<typeof base.updateProviderInstance>) =>
        Ref.update(writes, (previous) => [...previous, args[0].instanceId]).pipe(
          Effect.andThen(base.updateProviderInstance(...args)),
        ),
    } satisfies ServerSettingsService["Service"];
    return { counted, writes };
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
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
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
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
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
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  effectIt.effect("uses the resolved key for the catalog request but never persists it", () =>
    Effect.gen(function* () {
      const seenKeys: string[] = [];
      const { counted, writes } = yield* countingSettings;
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
      expect(JSON.stringify(settings.providerInstances)).not.toContain(SENTINEL_KEY);
      expect(JSON.stringify(yield* Ref.get(writes))).not.toContain(SENTINEL_KEY);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  effectIt.effect("with aix off and no managed instance, writes nothing", () =>
    Effect.gen(function* () {
      const { counted, writes } = yield* countingSettings;
      yield* syncAixProviderInstances({ enabled: false, source: sourceFor() }).pipe(
        Effect.provideService(ServerSettingsService, counted),
      );

      expect(yield* Ref.get(writes)).toEqual([]);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );
});
