import { groupWorkUsage, type WorkUsageRow } from "@t3tools/client-runtime/state/usage-grouping";
import {
  collectLimitAccounts,
  type LimitPresentations,
  paceRemainingPercent,
} from "@t3tools/shared/usageLimits";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

const CHART_COLORS = ["#7c8cf8", "#4fb7a5", "#ecad58", "#cb79b3"];

export function UsageLimitsWork({
  presentations,
  now,
}: {
  presentations: LimitPresentations;
  now: number;
}) {
  const usage = groupWorkUsage(
    collectLimitAccounts(presentations, { includeUnsupportedAix: true }),
    now,
  );
  const rows = usage.groups.flatMap((group) => group.rows);
  const reset = rows
    .flatMap((row) => (row.window?.resetsAt ? [row.window.resetsAt] : []))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  if (rows.length === 0) return null;
  const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date(now));
  const resetDate = reset
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(reset))
    : null;
  return (
    <View className="gap-3">
      <View className="gap-2 rounded-[24px] border-continuous bg-grouped-card p-4">
        <Text className="text-xs text-foreground-muted">
          {month}
          {resetDate ? ` · resets ${resetDate}` : ""}
        </Text>
        <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
          {formatUsd(usage.spent)} <Text className="text-sm text-foreground-muted">spent</Text>
        </Text>
        {usage.groups.length > 0 ? (
          <>
            <View className="h-2 flex-row overflow-hidden rounded-full bg-subtle">
              {usage.groups.map((group, index) => (
                <View
                  key={group.id ?? "no-project"}
                  style={{
                    width: `${usage.spent > 0 ? (group.spent / usage.spent) * 100 : 0}%`,
                    backgroundColor: CHART_COLORS[index % CHART_COLORS.length],
                  }}
                />
              ))}
            </View>
            <View className="flex-row flex-wrap gap-x-4 gap-y-1">
              {usage.groups.map((group, index) => (
                <View key={group.id ?? "no-project"} className="flex-row items-center gap-1.5">
                  <View
                    className="size-2 rounded-sm"
                    style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
                  />
                  <Text className="text-xs text-foreground-muted">
                    {group.name} {formatUsd(group.spent)}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}
      </View>
      {usage.flat ? (
        <View className="rounded-[24px] border-continuous bg-grouped-card px-4">
          {rows.map((row, index) => (
            <KeyRow key={row.account.key} row={row} now={now} divider={index > 0} />
          ))}
        </View>
      ) : (
        usage.groups.map((group) => (
          <View key={group.id ?? "no-project"} className="gap-3">
            <View className="flex-row flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1">
              <Text
                accessibilityRole="header"
                className="shrink text-base font-t3-medium text-foreground"
              >
                {group.name}
              </Text>
              {group.projectAmounts ? (
                <Text className="text-sm tabular-nums text-foreground-muted">
                  <Text className="font-t3-medium text-foreground">
                    {formatUsd(group.projectAmounts.spent)}
                  </Text>{" "}
                  of {formatUsd(group.projectAmounts.total)}
                  {group.projectAmounts.total > 0
                    ? ` · ${Math.round((group.projectAmounts.spent / group.projectAmounts.total) * 100)}%`
                    : ""}
                </Text>
              ) : null}
            </View>
            <View className="rounded-[24px] border-continuous bg-grouped-card px-4 py-1">
              {group.rows.map((row, index) => (
                <KeyRow key={row.account.key} row={row} now={now} divider={index > 0} />
              ))}
            </View>
          </View>
        ))
      )}
    </View>
  );
}

function KeyRow({ row, now, divider }: { row: WorkUsageRow; now: number; divider: boolean }) {
  const window = row.window;
  const tick = window ? paceRemainingPercent(window, now) : null;
  const tone =
    row.status === "nearLimit" ? "destructive" : row.status === "overPace" ? "warning" : null;
  const amounts = window?.amounts;
  return (
    <View className={`gap-1.5 py-2.5 ${divider ? "border-t border-border-subtle" : ""}`}>
      <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <View className="min-w-0 shrink flex-row items-center gap-2">
          <Text numberOfLines={1} className="shrink text-sm font-t3-medium text-foreground">
            {row.label}
          </Text>
          {tone ? (
            <View className="rounded-full bg-subtle px-2 py-0.5">
              <Text
                className={`text-xs font-t3-medium ${tone === "destructive" ? "text-danger-foreground" : "text-warning-foreground"}`}
              >
                {row.status === "nearLimit" ? "Near limit" : "Over pace"}
              </Text>
            </View>
          ) : null}
        </View>
        {amounts ? (
          <Text className="text-sm tabular-nums text-foreground-muted">
            <Text className="font-t3-medium text-foreground">{formatUsd(amounts.spent)}</Text> /{" "}
            {formatUsd(amounts.total)}
          </Text>
        ) : null}
      </View>
      {!amounts && row.message ? (
        <Text className="text-xs text-foreground-muted">{row.message}</Text>
      ) : null}
      {amounts ? <UsageBar usedPercent={row.usedPercent} tick={tick} tone={tone} /> : null}
    </View>
  );
}

function UsageBar({
  usedPercent,
  tick,
  tone,
}: {
  readonly usedPercent: number;
  readonly tick?: number | null;
  readonly tone?: "destructive" | "warning" | null;
}) {
  const color = tone === "destructive" ? "#e5484d" : tone === "warning" ? "#d99b26" : "#8b8b94";
  return (
    <View className="h-1.5 overflow-visible rounded-full bg-subtle">
      <View
        className="h-full rounded-full"
        style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%`, backgroundColor: color }}
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
