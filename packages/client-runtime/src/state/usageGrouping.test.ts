import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  filterLimitPresentationsByGroup,
  groupLimitAccounts,
  usageLimitGroupForProvider,
  usageLimitGroupsInPresentations,
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
            usageLimitSources: [],
          },
        },
      ],
    ]);

    expect(usageLimitGroupsInPresentations(input)).toEqual(new Set(["personal", "work"]));
    expect(
      filterLimitPresentationsByGroup(input, "work").get(id)?.serverConfig?.providers,
    ).toHaveLength(1);
    expect(
      filterLimitPresentationsByGroup(input, "personal").get(id)?.serverConfig?.providers,
    ).toHaveLength(1);
  });
});
