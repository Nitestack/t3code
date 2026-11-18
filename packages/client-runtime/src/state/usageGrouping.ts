import {
  isProviderAvailable,
  type ServerProviderUsageAmounts,
  type ServerProvider,
  type UsageBucket,
  type UsageLimitsReport,
  type UsageSummary,
} from "@t3tools/contracts";
import {
  aixProfileNameFromWindowId,
  elapsedShare,
  type LimitAccount,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import { aixMetadataFromInstanceId, aixProfileLabels } from "../providerPickerHierarchy.ts";

export type UsageLimitGroup = "personal" | "work";
export type UsageScope = UsageLimitGroup;

export interface WorkUsageRow {
  readonly account: LimitAccount;
  readonly label: string;
  readonly window: LimitAccount["limits"]["windows"][number] | undefined;
  readonly usedPercent: number;
  readonly elapsedPercent: number | null;
  readonly status: "nearLimit" | "overPace" | null;
  readonly message: string | undefined;
}

export interface WorkUsageGroup {
  readonly id: string | null;
  readonly name: string;
  readonly projectAmounts: ServerProviderUsageAmounts | undefined;
  readonly rows: readonly WorkUsageRow[];
  readonly spent: number;
}

export interface WorkUsageGroups {
  readonly groups: readonly WorkUsageGroup[];
  readonly flat: boolean;
  readonly spent: number;
}

/** Group newer Gateway reports by project while keeping older server reports flat. */
export function groupWorkUsage(accounts: readonly LimitAccount[], now: number): WorkUsageGroups {
  const latestByCredential = new Map<string, LimitAccount>();
  for (const account of accounts) {
    const key = account.limits.credentialFingerprint
      ? `credential:${account.limits.credentialFingerprint}`
      : `account:${account.key}`;
    const previous = latestByCredential.get(key);
    if (!previous || Date.parse(account.limits.checkedAt) > Date.parse(previous.limits.checkedAt)) {
      latestByCredential.set(key, account);
    }
  }
  const unique = [...latestByCredential.values()];
  const flat = unique.every((account) => account.limits.aixProject?.id === undefined);
  const groups = new Map<string, { id: string | null; accounts: LimitAccount[] }>();
  for (const account of unique) {
    const project = account.limits.aixProject;
    const id = project?.id ?? null;
    const key = id ?? "no-project";
    const group = groups.get(key);
    if (group) group.accounts.push(account);
    else groups.set(key, { id, accounts: [account] });
  }

  const result = [...groups.values()].map(({ id, accounts: members }): WorkUsageGroup => {
    const projectReport = members
      .filter((account) => account.limits.aixProject && account.limits.aixProject.id === id)
      .sort(
        (left, right) => Date.parse(right.limits.checkedAt) - Date.parse(left.limits.checkedAt),
      )[0]?.limits.aixProject;
    const rows = members
      .map((account): WorkUsageRow => {
        const window = account.limits.windows[0];
        const usedPercent = window?.usedPercent ?? 0;
        const elapsed = window ? elapsedShare(window, now) : null;
        return {
          account,
          label:
            account.profileLabel?.trim() ||
            account.profileName?.trim() ||
            account.displayName?.trim() ||
            "Work key",
          window,
          usedPercent,
          elapsedPercent: elapsed === null ? null : elapsed * 100,
          status:
            usedPercent >= 95
              ? "nearLimit"
              : elapsed !== null && usedPercent > elapsed * 100
                ? "overPace"
                : null,
          message: account.limits.unavailable?.message,
        };
      })
      .sort(
        (left, right) =>
          right.usedPercent - left.usedPercent || left.label.localeCompare(right.label),
      );
    return {
      id,
      // The gateway names no project, so it takes the name of the key that spends the most.
      name:
        id === null
          ? "No project"
          : ([...rows].sort(
              (left, right) =>
                (right.window?.amounts?.spent ?? 0) - (left.window?.amounts?.spent ?? 0) ||
                left.label.localeCompare(right.label),
            )[0]?.label ?? "Work"),
      projectAmounts:
        projectReport && "amounts" in projectReport ? projectReport.amounts : undefined,
      rows,
      spent: rows.reduce((sum, row) => sum + (row.window?.amounts?.spent ?? 0), 0),
    };
  });
  return {
    groups: result.sort(
      (left, right) =>
        Number(left.id === null) - Number(right.id === null) || left.name.localeCompare(right.name),
    ),
    flat,
    spent: result.reduce((sum, group) => sum + group.spent, 0),
  };
}

type ReportAccount = UsageLimitsReport["accounts"][number];

export const reportAccountLabel = (account: ReportAccount) =>
  account.displayName?.trim() || account.limits.profileName || account.label;

const AIX_INSTANCE_PROFILE = /^aix-[^-]+-(.+)$/u;

/** The thread's Work key first, then its project siblings, named the way the usage page names them. */
export function composerWorkUsage<A extends ReportAccount>(
  accounts: readonly A[],
  providerInstanceId: string | null | undefined,
) {
  const workAccounts = accounts.filter((account) => account.limits.profileName);
  // A profile reports through one of its driver instances, not necessarily the thread's.
  const threadProfile = providerInstanceId
    ? AIX_INSTANCE_PROFILE.exec(providerInstanceId)?.[1]
    : undefined;
  const threadAccount =
    workAccounts.find((account) => account.instanceId === providerInstanceId) ??
    workAccounts.find((account) => account.limits.profileName === threadProfile);
  const selected = threadAccount ?? workAccounts[0];
  if (!selected) return null;
  const project = selected.limits.aixProject;
  const siblings = project
    ? workAccounts.filter(
        (account) => account.id !== selected.id && account.limits.aixProject?.id === project.id,
      )
    : [];
  const ordered = [
    selected,
    ...siblings.sort(
      (left, right) =>
        (right.limits.windows[0]?.usedPercent ?? 0) - (left.limits.windows[0]?.usedPercent ?? 0),
    ),
  ];
  const topSpender = [...ordered].sort(
    (left, right) =>
      (right.limits.windows[0]?.amounts?.spent ?? 0) -
        (left.limits.windows[0]?.amounts?.spent ?? 0) ||
      reportAccountLabel(left).localeCompare(reportAccountLabel(right)),
  )[0];
  return {
    selected,
    isThread: selected === threadAccount,
    ordered,
    name: reportAccountLabel(project && topSpender ? topSpender : selected),
    projectAmounts: project?.amounts,
    resetsAt: selected.limits.windows[0]?.resetsAt,
  };
}

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
        (limits.unavailable?.reason !== "unsupported" ||
          usageLimitGroupForProvider(provider) === "work")
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
