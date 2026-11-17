import { providerClients } from "@t3tools/client-runtime/provider-clients";
import { resolveUsageLimitAccountsScope } from "@t3tools/shared/usageLimits";
import type {
  EnvironmentId,
  ProviderInstanceId,
  UsageLimitsReport,
  UsageScope,
} from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";
import { useState } from "react";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { paceRemainingPercent } from "@t3tools/shared/usageLimits";

import { SymbolView } from "../../components/ui/AppSymbol";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { AppText as Text } from "../../components/ui/AppText";
import { AccountLimits, ResetCredits } from "../usage/UsageLimitsSection";

export function ComposerUsageLimits({
  report,
  environmentId,
  providerInstanceId,
  maxHeight,
  selectedScope,
  onClose,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly maxHeight: number;
  readonly selectedScope: UsageScope;
  readonly onClose: () => void;
}) {
  const [requestedScope, setRequestedScope] = useState<UsageScope | null>(null);
  const { accounts, groups, scope } = resolveUsageLimitAccountsScope(
    report.accounts,
    requestedScope,
    selectedScope,
  );
  const now = Date.parse(report.createdAt);
  const workAccount =
    accounts.find(
      (account) => account.instanceId === providerInstanceId && account.limits.profileName,
    ) ?? accounts.find((account) => account.limits.profileName);
  const project = workAccount?.limits.aixProject;
  const projectAccounts = project
    ? accounts.filter((account) => account.limits.aixProject?.id === project.id)
    : workAccount
      ? [workAccount]
      : [];
  const workGroupName = project
    ? ([...projectAccounts]
        .map((account) => account.displayName?.trim() || account.label)
        .sort((left, right) => left.localeCompare(right))[0] ?? "Work")
    : workAccount?.limits.aixProject === undefined
      ? workAccount?.displayName?.trim() || workAccount?.label || "Work"
      : "No project";
  const workReset = workAccount?.limits.windows[0]?.resetsAt;
  const close = (
    <Pressable
      accessibilityLabel="Dismiss usage limits"
      accessibilityRole="button"
      hitSlop={12}
      onPress={onClose}
      className="-me-1 p-1 active:opacity-60"
    >
      <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" type="monochrome" />
    </Pressable>
  );
  return (
    <View className="overflow-hidden rounded-[20px] border-continuous bg-card">
      <ScrollView bounces={false} showsVerticalScrollIndicator={false} style={{ maxHeight }}>
        {groups.size > 1 ? (
          <View className="px-4 pt-3">
            <SegmentedControl
              size="compact"
              selected={scope}
              onSelect={setRequestedScope}
              options={[
                { value: "personal", label: "Personal" },
                { value: "work", label: "Work" },
              ]}
            />
          </View>
        ) : null}
        {scope === "work" ? (
          <>
            <View className="flex-row items-center justify-between gap-3 px-4 pt-3">
              <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
                {workGroupName} · Work
                {workReset
                  ? ` · resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(workReset))}`
                  : ""}
              </Text>
              {close}
            </View>
            <WorkUsageLimitsRows
              accounts={accounts}
              providerInstanceId={providerInstanceId}
              now={now}
            />
          </>
        ) : (
          accounts.map((account, index) => {
            const resetCreditInput =
              account.resetCreditInput ??
              (account.instanceId ? { instanceId: account.instanceId } : undefined);
            const driverLabel = providerClients.get(account.driver)?.label ?? account.driver;
            return (
              <AccountLimits
                key={account.id}
                dense
                first={index === 0}
                driver={account.driver}
                accentColor={account.accentColor}
                label={driverLabel}
                instanceLabel={
                  account.instanceId
                    ? account.displayName?.trim() ||
                      (String(account.instanceId) !== String(account.driver)
                        ? account.instanceId
                        : driverLabel)
                    : account.label
                }
                detail={account.plan}
                limits={account.limits}
                now={now}
                trailing={index === 0 ? close : undefined}
                footer={
                  resetCreditInput && account.limits.resetCredits ? (
                    <ResetCredits
                      dense
                      environmentId={environmentId}
                      input={resetCreditInput}
                      credits={account.limits.resetCredits}
                      now={now}
                    />
                  ) : undefined
                }
              />
            );
          })
        )}
        {scope !== "work" && accounts.length === 0 ? (
          <View className="flex-row items-center gap-3 px-4 pt-3">
            <Text className="min-w-0 flex-1 text-base text-foreground">Usage limits</Text>
            {close}
          </View>
        ) : null}
        {report.notices.map((notice) => (
          <Text
            key={notice}
            className={
              accounts.length === 0
                ? "px-4 py-3 text-xs text-foreground-muted"
                : "border-t border-border-subtle px-4 py-3 text-xs text-foreground-muted"
            }
          >
            {notice}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

function WorkUsageLimitsRows({
  accounts,
  providerInstanceId,
  now,
}: {
  readonly accounts: UsageLimitsReport["accounts"];
  readonly providerInstanceId?: ProviderInstanceId;
  readonly now: number;
}) {
  const selected =
    accounts.find(
      (account) => account.instanceId === providerInstanceId && account.limits.profileName,
    ) ?? accounts.find((account) => account.limits.profileName);
  if (!selected) return null;
  const project = selected.limits.aixProject;
  const projectAccounts = project
    ? accounts.filter((account) => account.limits.aixProject?.id === project.id)
    : [selected];
  const ordered = [
    selected,
    ...projectAccounts
      .filter((account) => account.id !== selected.id)
      .sort(
        (left, right) =>
          (right.limits.windows[0]?.usedPercent ?? 0) - (left.limits.windows[0]?.usedPercent ?? 0),
      ),
  ];
  const groupName = project
    ? ([...ordered]
        .map((account) => account.displayName?.trim() || account.label)
        .sort((left, right) => left.localeCompare(right))[0] ?? "Work")
    : selected.limits.aixProject === undefined
      ? selected.displayName?.trim() || selected.label
      : "No project";
  return (
    <View className="px-4 pb-3">
      {ordered.map((account, index) => {
        const window = account.limits.windows[0];
        const tick = window ? paceRemainingPercent(window, now) : null;
        return (
          <View
            key={account.id}
            className="flex-row flex-wrap items-center justify-between gap-x-3 border-t border-border-subtle py-2"
          >
            <View className="min-w-0 flex-1 flex-row items-center gap-1">
              <Text
                numberOfLines={1}
                className={`${index === 0 ? "text-sm font-t3-medium text-foreground" : "text-xs text-foreground-muted"}`}
              >
                {account.displayName?.trim() || account.label}
              </Text>
              {index === 0 && account.instanceId === providerInstanceId ? (
                <Text className="text-xs text-foreground-muted">· this thread</Text>
              ) : null}
            </View>
            {window?.amounts ? (
              <Text className="text-sm tabular-nums text-foreground">
                {formatUsd(window.amounts.spent)}
                <Text className="text-foreground-muted"> / {formatUsd(window.amounts.total)}</Text>
              </Text>
            ) : account.limits.unavailable?.message ? (
              <Text className="text-xs text-foreground-muted">
                {account.limits.unavailable.message}
              </Text>
            ) : null}
            {window?.amounts ? (
              <UsageAmountBar usedPercent={window.usedPercent} tick={tick} />
            ) : null}
          </View>
        );
      })}
      {project?.amounts ? (
        <View className="flex-row flex-wrap items-center justify-between gap-x-3 border-t border-border-subtle py-2">
          <Text className="text-xs text-foreground-muted">{groupName} total (team)</Text>
          <Text className="text-sm tabular-nums text-foreground">
            {formatUsd(project.amounts.spent)}
            <Text className="text-foreground-muted"> / {formatUsd(project.amounts.total)}</Text>
          </Text>
          <UsageAmountBar
            usedPercent={
              project.amounts.total > 0 ? (project.amounts.spent / project.amounts.total) * 100 : 0
            }
          />
        </View>
      ) : null}
    </View>
  );
}

function UsageAmountBar({
  usedPercent,
  tick,
}: {
  readonly usedPercent: number;
  readonly tick?: number | null;
}) {
  return (
    <View className="h-1.5 w-full overflow-visible rounded-full bg-subtle">
      <View
        className="h-full rounded-full bg-foreground/75"
        style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }}
      />
      {tick !== undefined && tick !== null ? (
        <View
          className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-foreground-muted"
          style={{ left: `${Math.min(100, Math.max(0, 100 - tick))}%` }}
        />
      ) : null}
    </View>
  );
}
