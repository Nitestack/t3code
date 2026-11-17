import type {
  EnvironmentId,
  ProviderInstanceId,
  UsageLimitsReport,
  UsageScope,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { limitsNotice, resolveUsageLimitAccountsScope } from "@t3tools/shared/usageLimits";
import { paceRemainingPercent } from "@t3tools/shared/usageLimits";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { GaugeIcon } from "lucide-react";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { UsageScopeControl } from "../usage/UsageScopeControl";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function accountLabel(account: UsageLimitsReport["accounts"][number]): string {
  if (account.limits.profileName) {
    return account.displayName?.trim() || account.limits.profileName;
  }
  if (!account.instanceId) return account.label;
  const driver = providerClients.get(account.driver)?.label ?? String(account.driver);
  const instance =
    account.displayName?.trim() ||
    (String(account.instanceId) !== String(account.driver) ? account.instanceId : "");
  return instance && instance.toLowerCase() !== driver.toLowerCase()
    ? `${driver} · ${instance}`
    : driver;
}

function AccountSummary({ account }: { readonly account: UsageLimitsReport["accounts"][number] }) {
  const label = accountLabel(account);
  return (
    <>
      {label.includes("@") ? (
        <RedactedSensitiveText
          key={label}
          value={label}
          ariaLabel="Toggle account label visibility"
          revealTooltip="Click to reveal account"
          hideTooltip="Click to hide account"
          className="max-w-full truncate align-bottom font-sans text-xs leading-normal"
        />
      ) : (
        label
      )}
      {account.plan ? ` · ${account.plan}` : null}
    </>
  );
}

export function usageLimitsBannerItem(
  id: string,
  report: UsageLimitsReport,
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId | null,
  selectedScope: UsageScope,
  onDismiss: () => void,
): ComposerBannerStackItem {
  // The body owns the scope toggle, so a split report gets a summary that holds for both scopes.
  const { accounts, groups } = resolveUsageLimitAccountsScope(report.accounts, null, selectedScope);
  const threadAccount = accounts.find((account) => account.instanceId === providerInstanceId);
  const projectAccounts = threadAccount?.limits.aixProject
    ? accounts
        .filter((account) => account.limits.aixProject?.id === threadAccount.limits.aixProject?.id)
        .sort((left, right) => accountLabel(left).localeCompare(accountLabel(right)))
    : threadAccount
      ? [threadAccount]
      : [];
  const groupName = threadAccount?.limits.aixProject
    ? projectAccounts[0]
      ? accountLabel(projectAccounts[0])
      : "Work"
    : threadAccount?.limits.aixProject === undefined
      ? threadAccount
        ? accountLabel(threadAccount)
        : "Work"
      : "No project";
  const reset = threadAccount?.limits.windows[0]?.resetsAt;
  const [first] = accounts;
  const single = accounts.length === 1 && first ? first : null;
  const summary =
    selectedScope === "work" ? (
      `${groupName} · Work${reset ? ` · resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(reset))}` : ""}`
    ) : groups.size > 1 ? (
      "Personal and Work"
    ) : single ? (
      <AccountSummary account={single} />
    ) : (
      `${accounts.length} accounts`
    );
  return {
    id,
    variant: "info",
    icon: <GaugeIcon />,
    title: "Usage limits",
    description: summary,
    dismissLabel: "Dismiss usage limits",
    onDismiss,
    children: (
      <UsageLimitsBannerBody
        report={report}
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        selectedScope={selectedScope}
      />
    ),
  };
}

export function modelFallbackBannerItem({
  fallbackModelName,
  defaultProviderName,
  defaultModelName,
  resetsAt,
  timestampFormat,
  onUseDefault,
  onDismiss,
}: {
  readonly fallbackModelName: string;
  readonly defaultProviderName: string;
  readonly defaultModelName: string;
  readonly resetsAt: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly onUseDefault: () => void;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  return {
    id: "fallback-model",
    variant: "info",
    icon: <GaugeIcon />,
    title: `Using ${fallbackModelName}`,
    description: `${defaultProviderName} is out of usage${resetsAt ? ` · resets ${formatUpcomingTimestamp(resetsAt, timestampFormat)}` : ""}`,
    actions: (
      <Button size="xs" variant="ghost" onClick={onUseDefault}>
        Use {defaultModelName}
      </Button>
    ),
    dismissLabel: "Dismiss fallback model notice",
    onDismiss,
  };
}

function UsageLimitsBannerBody({
  report,
  environmentId,
  providerInstanceId,
  selectedScope,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly selectedScope: UsageScope;
}) {
  const [requestedScope, setRequestedScope] = useState<UsageScope | null>(null);
  const { accounts, groups, scope } = resolveUsageLimitAccountsScope(
    report.accounts,
    requestedScope,
    selectedScope,
  );
  const now = Date.parse(report.createdAt);
  return (
    <ComposerBanner.Scroll>
      <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
        <UsageScopeControl groups={groups} scope={scope} onChange={setRequestedScope} />
        {scope === "work" ? (
          <WorkUsageLimitsRows
            accounts={accounts}
            providerInstanceId={providerInstanceId}
            now={now}
          />
        ) : (
          accounts.map((account) => {
            const resetCreditInput =
              account.resetCreditInput ??
              (account.instanceId ? { instanceId: account.instanceId } : undefined);
            const notice = limitsNotice(account.limits);
            const externalUsage = account.limits.externalUsage;
            return (
              <div key={account.id} className="flex min-w-0 flex-col gap-1">
                {accounts.length > 1 ? (
                  <span className="truncate text-xs text-muted-foreground">
                    <AccountSummary account={account} />
                  </span>
                ) : null}
                {notice ? (
                  <span className="text-xs text-muted-foreground">{notice}</span>
                ) : (
                  <LimitWindows
                    compact
                    driver={account.driver}
                    accentColor={account.accentColor}
                    windows={account.limits.windows}
                    now={now}
                  />
                )}
                {externalUsage ? (
                  <Button
                    size="sm"
                    variant="link"
                    className="self-start"
                    onClick={() => void ensureLocalApi().shell.openExternal(externalUsage.url)}
                  >
                    Manage usage
                  </Button>
                ) : null}
                {resetCreditInput && account.limits.resetCredits ? (
                  <ResetCredits
                    environmentId={environmentId}
                    input={resetCreditInput}
                    credits={account.limits.resetCredits}
                    now={now}
                  />
                ) : null}
              </div>
            );
          })
        )}
        {report.notices.map((notice) => (
          <span key={notice} className="text-xs text-muted-foreground">
            {notice}
          </span>
        ))}
      </ComposerBanner.Body>
    </ComposerBanner.Scroll>
  );
}

function WorkUsageLimitsRows({
  accounts,
  providerInstanceId,
  now,
}: {
  readonly accounts: UsageLimitsReport["accounts"];
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly now: number;
}) {
  const selected =
    accounts.find((account) => account.instanceId === providerInstanceId) ?? accounts[0];
  if (!selected) return null;
  const project = selected.limits.aixProject;
  const projectAccounts = project
    ? accounts.filter((account) => account.limits.aixProject?.id === project.id)
    : [selected];
  const sortedOthers = projectAccounts
    .filter((account) => account.id !== selected.id)
    .sort(
      (left, right) =>
        (right.limits.windows[0]?.usedPercent ?? 0) - (left.limits.windows[0]?.usedPercent ?? 0),
    );
  const ordered = [selected, ...sortedOthers];
  const groupName = project
    ? ([...ordered].map(accountLabel).sort((left, right) => left.localeCompare(right))[0] ?? "Work")
    : selected.limits.aixProject === undefined
      ? accountLabel(selected)
      : "No project";
  return (
    <div className="flex flex-col gap-0.5">
      {ordered.map((account, index) => {
        const window = account.limits.windows[0];
        const tick = window ? paceRemainingPercent(window, now) : null;
        return (
          <div
            key={account.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-t py-2 first:border-t-0"
          >
            <span
              className={`min-w-0 truncate ${index === 0 ? "text-sm font-medium text-foreground" : "text-xs text-muted-foreground"}`}
            >
              {accountLabel(account)}
              {index === 0 && account.instanceId === providerInstanceId ? (
                <span className="text-muted-foreground"> · this thread</span>
              ) : null}
            </span>
            {window?.amounts ? (
              <span className="text-sm tabular-nums">
                <b>{formatUsd(window.amounts.spent)}</b>
                <span className="text-muted-foreground"> / {formatUsd(window.amounts.total)}</span>
              </span>
            ) : account.limits.unavailable?.message ? (
              <span className="text-xs text-muted-foreground">
                {account.limits.unavailable.message}
              </span>
            ) : null}
            {window?.amounts ? (
              <UsageAmountBar usedPercent={window.usedPercent} tick={tick} />
            ) : null}
          </div>
        );
      })}
      {project?.amounts ? (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-t py-2">
          <span className="text-xs text-muted-foreground">{groupName} total (team)</span>
          <span className="text-sm tabular-nums">
            <b>{formatUsd(project.amounts.spent)}</b>
            <span className="text-muted-foreground"> / {formatUsd(project.amounts.total)}</span>
          </span>
          <UsageAmountBar
            usedPercent={
              project.amounts.total > 0 ? (project.amounts.spent / project.amounts.total) * 100 : 0
            }
          />
        </div>
      ) : null}
    </div>
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
    <div className="relative col-span-2 mt-1 h-1 overflow-hidden rounded-full bg-muted">
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-foreground/75"
        style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%` }}
      />
      {tick !== undefined && tick !== null ? (
        <span
          className="absolute inset-y-[-1px] w-0.5 bg-muted-foreground"
          style={{ left: `${Math.min(100, Math.max(0, 100 - tick))}%` }}
        />
      ) : null}
    </div>
  );
}
