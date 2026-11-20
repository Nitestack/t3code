import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  ThreadId,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  aixProfileNameFromWindowId,
  collectProviderUsageLimits,
  usageLimitsForProviderInstance,
  type LimitPace,
  paceOf,
  paceRemainingPercent,
  budgetLeftUsd,
  remainingPercent,
  remainingLabel,
} from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { msg, useGT, useLocale, useMessages } from "gt-react";
import type { ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { useEnvironmentQuery } from "../../state/query";
import { threadCostRead } from "../../state/orchestration";
import { ThreadDetailsCost } from "./ThreadDetailsCost";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
};

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
}

export interface ThreadDetailsUsageProps extends Omit<ThreadDetailsUsageInput, "contextWindow"> {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

type UsageTone = "error" | "warning" | null;

/** AIX threads show their calculated cost; other providers keep their limit windows. */
export function ThreadDetailsUsage(props: ThreadDetailsUsageProps) {
  const selected = props.providers.find(
    (provider) => provider.instanceId === props.providerInstanceId,
  );
  return selected?.aixProfile === undefined ? (
    <ThreadDetailsUsageLimits
      providerInstanceId={props.providerInstanceId}
      providers={props.providers}
      sources={props.sources}
    />
  ) : (
    <AixThreadDetailsCost {...props} />
  );
}

function AixThreadDetailsCost({ environmentId, threadId, ...usage }: ThreadDetailsUsageProps) {
  const cost = useEnvironmentQuery(threadCostRead({ environmentId, input: { threadId } }));
  if (cost.isSuccess && cost.data !== null) return <ThreadDetailsCost summary={cost.data} />;
  return <ThreadDetailsUsageLimits {...usage} />;
}

/** The selected provider's limit windows. Each row reads as room left. */
function ThreadDetailsUsageLimits({
  providerInstanceId,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow">) {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const report =
    providerInstanceId !== null
      ? collectProviderUsageLimits(providerInstanceId, providers, sources, now)
      : null;
  const selected = providers.find((provider) => provider.instanceId === providerInstanceId);
  const limits =
    (selected ? usageLimitsForProviderInstance(report, selected) : undefined) ??
    selected?.usageLimits;
  if (!limits) return null;
  const notice = limitsNotice(limits, m);

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={gt("Usage limits")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {notice ? (
          <UsageRow
            label={gt("Limits", { $context: "usage limits row label" })}
            fill={null}
            tone={null}
            value={gt("Unavailable")}
            tooltip={<span className="text-foreground">{notice}</span>}
            opensUsage
          />
        ) : (
          limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />)
        )}
      </div>
    </ThreadDetailsSection>
  );
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title={gt("Context window")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label={gt("Context", { $context: "context window row label" })}
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : usedTokens
          }
          ariaValue={
            used !== null
              ? gt("{used}% used", { used })
              : gt("{usedTokens} tokens used", { usedTokens })
          }
          tooltip={
            <>
              <span className="text-foreground">
                {used !== null
                  ? gt("Context: {used}% used", { used })
                  : gt("Context: {usedTokens} tokens used", { usedTokens })}
              </span>
              {maxTokens !== null ? (
                <span className="text-muted-foreground">
                  {gt("{used} of {max} tokens", {
                    used: usage.usedTokens.toLocaleString(locale),
                    max: maxTokens.toLocaleString(locale),
                  })}
                </span>
              ) : null}
              {threshold !== null && threshold > 0 ? (
                <span className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(threshold, m)}
                </span>
              ) : null}
            </>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}

function LimitRow({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const leftUsd = budgetLeftUsd(window);
  const pace = paceOf(window, now);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const profileName = aixProfileNameFromWindowId(window.id);
  const label = profileName ? `${profileName} budget` : window.label;
  return (
    <UsageRow
      label={label}
      fill={left}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      tick={timeLeft}
      value={leftUsd === undefined ? String(left) + "%" : formatUsd(leftUsd)}
      ariaValue={remainingLabel(window)}
      opensUsage
      tooltip={
        <>
          <span className="text-foreground">
            {leftUsd === undefined
              ? gt("{label}: {left}% left", { label, left })
              : label + ": " + remainingLabel(window)}
          </span>
          {pace && timeLeft !== null ? (
            <span className="text-muted-foreground">
              {m(PACE_LABEL[pace])} · {gt("{timeLeft}% of the window left", { timeLeft })}
            </span>
          ) : null}
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              {gt("Resets in {duration} · {time}", {
                duration: formatDuration(resetsAt - now, m),
                time: formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m),
              })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. With `opensUsage` it links to the usage page. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
  opensUsage = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
  readonly opensUsage?: boolean;
}) {
  const gt = useGT();
  const rowProps = {
    "aria-label": gt("{label}: {value}", { label, value: ariaValue }),
    className: cn(
      "col-span-3 grid h-6 grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]",
      opensUsage
        ? "group cursor-pointer active:bg-black/[0.06] dark:active:bg-white/[0.12]"
        : "cursor-default",
    ),
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          opensUsage ? <Link to="/usage" {...rowProps} /> : <div tabIndex={0} {...rowProps} />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground group-hover:text-foreground">
          {label}
        </span>
        {fill !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {fill > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${fill}%, 6px)` }}
              />
            ) : null}
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/75"
                style={{ left: `clamp(0.5px, ${tick}%, calc(100% - 0.5px))` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            fill === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : fill === null
                  ? "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">
          {tooltip}
          {opensUsage ? <span className="text-muted-foreground">{gt("Open usage")}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
