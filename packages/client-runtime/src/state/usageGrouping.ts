import { isProviderAvailable, type ServerProvider } from "@t3tools/contracts";
import {
  aixProfileNameFromWindowId,
  type LimitAccount,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";

export type UsageLimitGroup = "personal" | "work";

export function usageLimitGroupForProvider(
  provider: Pick<ServerProvider, "instanceId" | "usageLimits">,
): UsageLimitGroup {
  const limits = provider.usageLimits;
  const hasAixProfileMetadata =
    limits?.profileName !== undefined ||
    (limits?.windows.length === 1 &&
      aixProfileNameFromWindowId(limits.windows[0]!.id) !== undefined);
  return provider.instanceId.startsWith("aix-") || hasAixProfileMetadata ? "work" : "personal";
}

export function groupLimitAccounts(accounts: readonly LimitAccount[]): {
  readonly personal: readonly LimitAccount[];
  readonly work: readonly LimitAccount[];
} {
  const personal: LimitAccount[] = [];
  const work: LimitAccount[] = [];
  for (const account of accounts) {
    (account.profileName !== undefined || account.providerInstanceId?.startsWith("aix-")
      ? work
      : personal
    ).push(account);
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
