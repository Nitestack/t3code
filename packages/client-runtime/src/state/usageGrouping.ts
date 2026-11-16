import {
  isProviderAvailable,
  type ServerProvider,
  type UsageBucket,
  type UsageSummary,
} from "@t3tools/contracts";
import {
  aixProfileNameFromWindowId,
  type LimitAccount,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import { aixMetadataFromInstanceId, aixProfileLabels } from "../providerPickerHierarchy.ts";

export type UsageLimitGroup = "personal" | "work";
export type UsageScope = UsageLimitGroup;

export function usageAixProfileLabels(
  presentations: LimitPresentations,
): ReadonlyMap<string, string> {
  const entries = [];
  for (const presentation of presentations.values()) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      const profileId =
        provider.aixProfile ??
        provider.usageLimits?.profileName ??
        aixMetadataFromInstanceId(provider.instanceId, provider.driver)?.aixProfile;
      if (!profileId) continue;
      entries.push({
        instanceId: provider.instanceId,
        driverKind: provider.driver,
        enabled: true,
        aixProfile: profileId,
        aixProfileLabel: provider.aixProfileLabel,
      });
    }
  }
  return aixProfileLabels(entries);
}

function usageScopeForBucket(bucket: Pick<UsageBucket, "scope">): UsageScope {
  return bucket.scope === "work" ? "work" : "personal";
}

export function usageScopeGroupsInBuckets(
  buckets: readonly Pick<UsageBucket, "scope">[],
): ReadonlySet<UsageScope> {
  return new Set(buckets.map(usageScopeForBucket));
}

export function filterUsageBucketsByScope(
  buckets: readonly UsageBucket[],
  scope: UsageScope,
): readonly UsageBucket[] {
  return buckets.filter((bucket) => usageScopeForBucket(bucket) === scope);
}

export function filterUsageSummaryByScope<T extends Pick<UsageSummary, "buckets" | "sources">>(
  summary: T,
  scope: UsageScope,
): T {
  return {
    ...summary,
    buckets: filterUsageBucketsByScope(summary.buckets, scope),
    sources: summary.sources.map((source) => ({
      ...source,
      distinctSessions:
        source.distinctSessionsByScope?.[scope] ??
        (scope === "personal" ? source.distinctSessions : 0),
    })),
  };
}

const isAixIdentity = (instanceId: string | undefined, profileName: string | undefined) =>
  profileName !== undefined || instanceId?.startsWith("aix-") === true;

export function usageLimitGroupForProvider(
  provider: Pick<ServerProvider, "instanceId" | "usageLimits">,
): UsageLimitGroup {
  const limits = provider.usageLimits;
  const [onlyWindow, ...otherWindows] = limits?.windows ?? [];
  const legacyAixBudget =
    onlyWindow !== undefined &&
    otherWindows.length === 0 &&
    aixProfileNameFromWindowId(onlyWindow.id) !== undefined;
  return isAixIdentity(provider.instanceId, limits?.profileName) || legacyAixBudget
    ? "work"
    : "personal";
}

/** An explicit choice wins while that group has limits; otherwise the active scope, then Personal. */
export function resolveUsageLimitGroup(
  requested: UsageLimitGroup | null,
  groups: ReadonlySet<UsageLimitGroup>,
  activeScope: UsageLimitGroup,
): UsageLimitGroup {
  if (requested !== null && groups.has(requested)) return requested;
  if (groups.has(activeScope)) return activeScope;
  return groups.has("work") && !groups.has("personal") ? "work" : "personal";
}

export const usageLimitEmptyMessage = (group: UsageLimitGroup) =>
  group === "work"
    ? "No Work profile limits are available for the selected environments."
    : "No personal subscription limits are available for the selected environments.";

export function groupLimitAccounts(accounts: readonly LimitAccount[]): {
  readonly personal: readonly LimitAccount[];
  readonly work: readonly LimitAccount[];
} {
  const personal: LimitAccount[] = [];
  const work: LimitAccount[] = [];
  for (const account of accounts) {
    (isAixIdentity(account.providerInstanceId, account.profileName) ? work : personal).push(
      account,
    );
  }
  return { personal, work };
}

export function usageLimitGroupsInPresentations(
  presentations: LimitPresentations,
): ReadonlySet<UsageLimitGroup> {
  const groups = new Set<UsageLimitGroup>();
  for (const presentation of presentations.values()) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      const limits = provider.usageLimits;
      const isVisibleProvider =
        provider.enabled && provider.installed && isProviderAvailable(provider);
      if (
        isVisibleProvider &&
        limits !== undefined &&
        limits.unavailable?.reason !== "unsupported"
      ) {
        groups.add(usageLimitGroupForProvider(provider));
      }
      if (isVisibleProvider && limits?.externalUsage && provider.auth.status === "authenticated") {
        groups.add(usageLimitGroupForProvider(provider));
      }
    }
    if ((presentation.serverConfig?.usageLimitSources?.length ?? 0) > 0) groups.add("personal");
  }
  return groups;
}

export function filterLimitPresentationsByGroup(
  presentations: LimitPresentations,
  group: UsageLimitGroup,
): LimitPresentations {
  return new Map(
    [...presentations].map(([environmentId, presentation]) => {
      const config = presentation.serverConfig;
      if (config === null) return [environmentId, presentation] as const;
      return [
        environmentId,
        {
          ...presentation,
          serverConfig: {
            ...config,
            providers: config.providers.filter(
              (provider) => usageLimitGroupForProvider(provider) === group,
            ),
            usageLimitSources: group === "personal" ? config.usageLimitSources : [],
          },
        },
      ] as const;
    }),
  );
}
