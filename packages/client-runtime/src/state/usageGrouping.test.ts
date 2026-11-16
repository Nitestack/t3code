import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageDay,
  UsageLimitSourceId,
  type UsageBucket,
} from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  filterLimitPresentationsByGroup,
  filterUsageBucketsByScope,
  filterUsageSummaryByScope,
  groupLimitAccounts,
  resolveUsageLimitGroup,
  usageLimitGroupForProvider,
  usageLimitGroupsInPresentations,
  usageScopeGroupsInBuckets,
} from "./usageGrouping.ts";

const checkedAt = "2026-09-05T12:00:00.000Z";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt,
    models: [],
    slashCommands: [],
    ...overrides,
    skills: overrides.skills ?? [],
  };
}

function account(profileName?: string, providerInstanceId?: string): LimitAccount {
  return {
    key: profileName ? `aix-profile:${profileName}` : "native-codex",
    ...(providerInstanceId === undefined
      ? {}
      : { providerInstanceId: ProviderInstanceId.make(providerInstanceId) }),
    driver: ProviderDriverKind.make("codex"),
    displayName: profileName ?? "Codex",
    ...(profileName === undefined ? {} : { profileName }),
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt, windows: [] },
  };
}

describe("usage limit grouping", () => {
  it("filters usage by scope and treats buckets from older servers as Personal", () => {
    const bucket = (scope?: UsageBucket["scope"]): UsageBucket => ({
      day: UsageDay.make("2026-09-05"),
      ...(scope === undefined ? {} : { scope }),
      provider: "codex",
      model: "gpt-6.1",
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    });
    const buckets = [bucket(), bucket("work")];

    expect(usageScopeGroupsInBuckets(buckets)).toEqual(new Set(["personal", "work"]));
    expect(filterUsageBucketsByScope(buckets, "personal")).toEqual([buckets[0]]);
    expect(filterUsageBucketsByScope(buckets, "work")).toEqual([buckets[1]]);
    const summary = {
      buckets,
      sources: [
        {
          fingerprint: {
            hostId: "host",
            provider: "claude" as const,
            resolvedHomePath: "/.claude/projects",
            volumeId: "volume",
          },
          status: "ok" as const,
          scannedFiles: 2,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 2,
          distinctSessionsByScope: { personal: 1, work: 1 },
          message: null,
        },
      ],
    };
    expect(filterUsageSummaryByScope(summary, "work").sources[0]?.distinctSessions).toBe(1);
    expect(filterUsageSummaryByScope(summary, "personal").sources[0]?.distinctSessions).toBe(1);
  });

  it("classifies AIX profile metadata as Work regardless of its display name", () => {
    expect(
      usageLimitGroupForProvider(
        provider({
          instanceId: ProviderInstanceId.make("aix-codex-personal"),
          displayName: "Persönlich",
          usageLimits: { checkedAt, profileName: "personal", windows: [] },
        }),
      ),
    ).toBe("work");
  });

  it("uses AIX budget metadata when a profile name is absent", () => {
    expect(
      usageLimitGroupForProvider(
        provider({
          instanceId: ProviderInstanceId.make("codex"),
          displayName: "Work",
          usageLimits: {
            checkedAt,
            windows: [{ id: "aix-budget:work", kind: "other", label: "Budget", usedPercent: 25 }],
          },
        }),
      ),
    ).toBe("work");
  });

  it("keeps non-AIX provider labels out of classification", () => {
    expect(usageLimitGroupForProvider(provider({ displayName: "Work" }))).toBe("personal");
    expect(
      groupLimitAccounts([account("Persönlich"), account(), account(undefined, "aix-codex-work")]),
    ).toEqual({
      personal: [account()],
      work: [account("Persönlich"), account(undefined, "aix-codex-work")],
    });
  });

  it("keeps AIX providers out of Personal presentations and other sources out of Work", () => {
    const id = EnvironmentId.make("env");
    const input = new Map([
      [
        id,
        {
          entry: { target: { label: "Remote" } },
          serverConfig: {
            providers: [
              provider({
                instanceId: ProviderInstanceId.make("aix-codex-work"),
                usageLimits: { checkedAt, profileName: "work", windows: [] },
              }),
              provider({ usageLimits: { checkedAt, windows: [] } }),
            ],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy" as const,
                label: "hub",
                checkedAt,
                accounts: [],
              },
            ],
          },
        },
      ],
    ]);

    expect(usageLimitGroupsInPresentations(input)).toEqual(new Set(["personal", "work"]));
    const work = filterLimitPresentationsByGroup(input, "work").get(id)?.serverConfig;
    const personal = filterLimitPresentationsByGroup(input, "personal").get(id)?.serverConfig;
    expect(work?.providers.map((entry) => entry.instanceId)).toEqual(["aix-codex-work"]);
    expect(work?.usageLimitSources).toEqual([]);
    expect(personal?.providers.map((entry) => entry.instanceId)).toEqual(["codex"]);
    expect(personal?.usageLimitSources?.map((source) => source.id)).toEqual(["hub"]);
  });

  it("shows the chosen group while it has limits, then the active scope, then Personal", () => {
    const both = new Set(["personal", "work"] as const);
    const workOnly = new Set(["work"] as const);
    expect(resolveUsageLimitGroup("work", both, "personal")).toBe("work");
    expect(resolveUsageLimitGroup(null, both, "work")).toBe("work");
    expect(resolveUsageLimitGroup("personal", workOnly, "personal")).toBe("work");
    expect(resolveUsageLimitGroup(null, new Set(), "work")).toBe("personal");
  });
});
