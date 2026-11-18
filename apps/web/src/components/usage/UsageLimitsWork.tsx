import { groupWorkUsage, type WorkUsageRow } from "@t3tools/client-runtime/state/usage-grouping";
import {
  collectLimitAccounts,
  collectLimitNotices,
  type LimitPresentations,
  paceRemainingPercent,
} from "@t3tools/shared/usageLimits";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { cn } from "~/lib/utils";
import { LimitNotices } from "./UsageLimitsPooled";

const chartColors = ["#7c8cf8", "#4fb7a5", "#ecad58", "#cb79b3"];

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
  const notices = collectLimitNotices(presentations);
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {notices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Work profile limits are available for the selected environments.
          </p>
        ) : null}
        <LimitNotices notices={notices} />
      </div>
    );
  }
  const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date(now));
  const resets = reset
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(reset))
    : null;

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <p className="text-xs text-muted-foreground">
          {month}
          {resets ? ` · resets ${resets}` : ""}
        </p>
        <p className="text-3xl font-semibold text-foreground tabular-nums">
          {formatUsd(usage.spent)}{" "}
          <span className="text-sm font-normal text-muted-foreground">spent</span>
        </p>
        {usage.groups.length > 0 ? (
          <>
            <div
              className="flex h-2 overflow-hidden rounded-full bg-muted"
              aria-label="Usage by group"
            >
              {usage.groups.map((group, index) => (
                <span
                  key={group.id ?? "no-project"}
                  className="h-full"
                  style={{
                    width: `${usage.spent > 0 ? (group.spent / usage.spent) * 100 : 0}%`,
                    backgroundColor: chartColors[index % chartColors.length],
                  }}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {usage.groups.map((group, index) => (
                <span key={group.id ?? "no-project"} className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 rounded-sm"
                    style={{ backgroundColor: chartColors[index % chartColors.length] }}
                  />
                  {group.name} {formatUsd(group.spent)}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </section>

      {usage.flat ? (
        <section className="rounded-xl border bg-card px-4">
          {rows.map((row, index) => (
            <KeyRow key={row.account.key} row={row} now={now} divider={index > 0} />
          ))}
        </section>
      ) : (
        usage.groups.map((group) => (
          <section key={group.id ?? "no-project"} className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3 px-0.5">
              <h2 className="truncate text-sm font-medium text-foreground">{group.name}</h2>
              {group.projectAmounts ? (
                <span className="shrink-0 text-sm tabular-nums">
                  <b>{formatUsd(group.projectAmounts.spent)}</b>
                  <span className="text-muted-foreground">
                    {" "}
                    of {formatUsd(group.projectAmounts.total)}
                    {group.projectAmounts.total > 0
                      ? ` · ${Math.round((group.projectAmounts.spent / group.projectAmounts.total) * 100)}%`
                      : ""}
                  </span>
                </span>
              ) : null}
            </div>
            <div className="rounded-xl border bg-card px-4 py-1">
              {group.rows.map((row, index) => (
                <KeyRow key={row.account.key} row={row} now={now} divider={index > 0} />
              ))}
            </div>
          </section>
        ))
      )}
      <LimitNotices notices={notices} />
    </div>
  );
}

function KeyRow({ row, now, divider }: { row: WorkUsageRow; now: number; divider: boolean }) {
  const window = row.window;
  const tick = window ? paceRemainingPercent(window, now) : null;
  const tone =
    row.status === "nearLimit" ? "destructive" : row.status === "overPace" ? "warning" : null;
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2", divider && "border-t")}>
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <span className="truncate">{row.label}</span>
        {row.status === "nearLimit" ? <StatusChip tone="destructive">Near limit</StatusChip> : null}
        {row.status === "overPace" ? <StatusChip tone="warning">Over pace</StatusChip> : null}
      </span>
      {window?.amounts ? (
        <span className="text-sm tabular-nums">
          <b>{formatUsd(window.amounts.spent)}</b>
          <span className="text-muted-foreground"> / {formatUsd(window.amounts.total)}</span>
        </span>
      ) : row.message ? (
        <span className="text-xs text-muted-foreground">{row.message}</span>
      ) : null}
      {window?.amounts ? (
        <div className="col-span-2 mt-1">
          <UsageBar usedPercent={row.usedPercent} tick={tick} tone={tone} thin />
        </div>
      ) : null}
    </div>
  );
}

function UsageBar({
  usedPercent,
  tick,
  tone,
  thin = false,
}: {
  readonly usedPercent: number;
  readonly tick?: number | null;
  readonly tone?: "destructive" | "warning" | null;
  readonly thin?: boolean;
}) {
  const color =
    tone === "destructive"
      ? "var(--destructive)"
      : tone === "warning"
        ? "var(--warning)"
        : "var(--foreground)";
  return (
    <div className={`relative overflow-hidden rounded-full bg-muted ${thin ? "h-1" : "h-2"}`}>
      <span
        className="absolute inset-y-0 left-0 rounded-full opacity-75"
        style={{ width: `${Math.min(100, Math.max(0, usedPercent))}%`, backgroundColor: color }}
      />
      {tick !== undefined && tick !== null ? (
        <span
          aria-hidden
          className="absolute inset-y-[-1px] w-0.5 bg-muted-foreground"
          style={{ left: `${Math.min(100, Math.max(0, 100 - tick))}%` }}
        />
      ) : null}
    </div>
  );
}

function StatusChip({ children, tone }: { children: string; tone: "destructive" | "warning" }) {
  return (
    <span
      className={`shrink-0 rounded-full bg-muted px-2 py-0.5 text-3xs font-medium ${tone === "destructive" ? "text-destructive" : "text-warning"}`}
    >
      {children}
    </span>
  );
}
