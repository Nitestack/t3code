import type { OrchestrationV2ThreadCostSummary } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

export function ThreadDetailsCost({
  summary,
}: {
  readonly summary: OrchestrationV2ThreadCostSummary;
}) {
  return (
    <ThreadDetailsSection
      headingId="thread-details-cost-heading"
      title="Thread cost"
      showHeading={false}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-xs">
        <CostRow className="col-span-2" label="Thread cost" costUsd={summary.totalCostUsd} />
        <details className="group/cost col-span-2">
          <summary className="grid min-h-6 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-white/[0.08] [&::-webkit-details-marker]:hidden">
            <span className="text-muted-foreground">Details</span>
            <ChevronDownIcon
              aria-hidden="true"
              className="size-3.5 text-muted-foreground transition-transform group-open/cost:rotate-180"
            />
          </summary>
          <div className="space-y-0.5 pt-1">
            <CostRow label="Main thread" costUsd={summary.mainThreadCostUsd} className="pl-4" />
            {summary.subagents.length > 0 ? (
              <>
                <div className="grid h-6 grid-cols-[minmax(0,1fr)_auto] items-center px-4 text-muted-foreground">
                  Subagents
                </div>
                <div className="ml-5 space-y-0.5 border-l border-border/65 pl-2">
                  {summary.subagents.map((subagent) => (
                    <CostRow
                      key={subagent.threadId}
                      label={subagent.title}
                      costUsd={subagent.costUsd}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </details>
      </div>
    </ThreadDetailsSection>
  );
}

function CostRow({
  label,
  costUsd,
  className,
}: {
  readonly label: string;
  readonly costUsd: number;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "grid min-h-6 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-2.5",
        className,
      )}
    >
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
      <span className="whitespace-nowrap text-right tabular-nums">{formatUsd(costUsd)}</span>
    </div>
  );
}
