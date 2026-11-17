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
  groupWorkUsage,
  groupLimitAccounts,
  resolveUsageLimitGroup,
  usageLimitGroupForProvider,
  usageLimitGroupsInPresentations,
  usageAixProfileLabels,
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

function workAccount(input: {
  readonly key: string;
  readonly label: string;
  readonly project?: { readonly id: string; readonly spent: number; readonly total: number };
  readonly fingerprint?: string;
  readonly spent?: number;
  readonly total?: number;
  readonly usedPercent?: number;
  readonly checkedAt?: string;
}): LimitAccount {
  const spent = input.spent ?? 0;
  const total = input.total ?? 100;
  const usedPercent = input.usedPercent ?? (total > 0 ? (spent / total) * 100 : 0);
  return {
    ...account(input.key),
    key: input.key,
    displayName: input.label,
    profileName: input.key,
    profileLabel: input.label,
    limits: {
      checkedAt: input.checkedAt ?? checkedAt,
      ...(input.fingerprint === undefined ? {} : { credentialFingerprint: input.fingerprint }),
      ...(input.project === undefined
        ? {}
        : {
            aixProject: {
              id: input.project.id,
              amounts: {
                currency: "USD",
                spent: input.project.spent,
                total: input.project.total,
              },
            },
          }),
      windows:
        total <= 0
          ? []
          : [
              {
                id: `aix-budget:${input.key}`,
                kind: "other",
                label: input.label,
                usedPercent,
                amounts: { currency: "USD", spent, total },
                resetsAt: "2026-09-05T20:20:00.000Z",
                windowDurationMins: 1000,
              },
            ],
      ...(total <= 0
        ? { unavailable: { reason: "unsupported" as const, message: "No budget" } }
        : {}),
    },
  };
}

describe("usage limit grouping", () => {
  it("groups Gateway keys by project and names it after its top-spending key", () => {
    const grouped = groupWorkUsage(
      [
        workAccount({
          key: "zeta",
          label: "Zeta",
          project: { id: "project-a", spent: 300, total: 500 },
          spent: 30,
        }),
        workAccount({
          key: "alpha",
          label: "Alpha",
          project: { id: "project-a", spent: 300, total: 500 },
          spent: 20,
        }),
        workAccount({ key: "personal-key", label: "Personal key", spent: 10 }),
      ],
      Date.parse(checkedAt),
    );

    expect(grouped.flat).toBe(false);
    expect(grouped.spent).toBe(60);
    expect(grouped.groups.map((group) => [group.id, group.name])).toEqual([
      ["project-a", "Zeta"],
      [null, "No project"],
    ]);
    expect(grouped.groups[0]?.projectAmounts).toEqual({ currency: "USD", spent: 300, total: 500 });
  });

  it("keeps older server reports flat and deduplicates a credential across environments", () => {
    const legacy = groupWorkUsage(
      [
        workAccount({ key: "same-a", label: "A", fingerprint: "shared", spent: 12 }),
        workAccount({
          key: "same-b",
          label: "B",
          fingerprint: "shared",
          spent: 20,
          checkedAt: "2026-09-06T12:00:00.000Z",
        }),
        workAccount({ key: "other", label: "Other", spent: 4 }),
      ],
      Date.parse(checkedAt),
    );
    expect(legacy.flat).toBe(true);
    expect(legacy.groups).toHaveLength(1);
    expect(legacy.groups[0]?.rows.map((row) => row.label)).toEqual(["B", "Other"]);
    expect(legacy.spent).toBe(24);
  });

  it("sorts keys by used percent and reports near-limit and over-pace thresholds", () => {
    const result = groupWorkUsage(
      [
        workAccount({ key: "steady", label: "Steady", spent: 40 }),
        workAccount({ key: "pace", label: "Pace", usedPercent: 60, spent: 60 }),
        workAccount({ key: "near", label: "Near", usedPercent: 96, spent: 96 }),
      ],
      Date.parse("2026-09-05T20:20:00.000Z") - 30_000_000,
    );
    const rows = result.groups[0]?.rows ?? [];
    expect(rows.map((row) => [row.label, row.status])).toEqual([
      ["Near", "nearLimit"],
      ["Pace", "overPace"],
      ["Steady", null],
    ]);
  });

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

  it("resolves Work usage headings from the current AIX provider labels", () => {
    const id = EnvironmentId.make("env");
    const presentations = new Map([
      [
        id,
        {
          entry: { target: { label: "Remote" } },
          serverConfig: {
            providers: [
              provider({
                instanceId: ProviderInstanceId.make("aix-codex-ac"),
                aixProfile: "ac",
                aixProfileLabel: "adCare",
                usageLimits: { checkedAt, profileName: "ac", windows: [] },
              }),
            ],
            usageLimitSources: [],
          },
        },
      ],
    ]);

    expect(usageAixProfileLabels(presentations).get("ac")).toBe("adCare");
    const updated = new Map([
      [
        id,
        {
          entry: { target: { label: "Remote" } },
          serverConfig: {
            providers: [
              provider({
                instanceId: ProviderInstanceId.make("aix-codex-ac"),
                aixProfile: "ac",
                aixProfileLabel: "Persönlich",
                usageLimits: { checkedAt, profileName: "ac", windows: [] },
              }),
            ],
            usageLimitSources: [],
          },
        },
      ],
    ]);
    expect(usageAixProfileLabels(updated).get("ac")).toBe("Persönlich");
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
