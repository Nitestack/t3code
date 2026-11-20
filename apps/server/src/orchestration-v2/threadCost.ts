import type {
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadCostSummary,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ThreadId,
  UsageModelPriceOverride,
} from "@t3tools/contracts";

import { aixGatewayModelPrices } from "../aix/ProviderInstanceSync.ts";
import {
  createGatewayRateTable,
  createOverrideRateTable,
  priceUsage,
  type RateTable,
} from "../usage/usagePricing.ts";

export interface ThreadCostProjection {
  readonly thread: { readonly id: ThreadId; readonly title: string };
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "origin" | "childThreadId" | "remoteChild" | "title">
  >;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "turnTokenUsage" | "model">
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "providerInstanceId" | "providerSessionId">
  >;
  readonly providerSessions: ReadonlyArray<Pick<OrchestrationV2ProviderSession, "id" | "model">>;
}

interface ThreadCostSettings {
  readonly providerInstances: ProviderInstanceConfigMap;
  readonly usagePriceOverrides: Readonly<Record<string, UsageModelPriceOverride>>;
}

/** Returns null rather than presenting a total when any recorded model usage cannot be priced. */
export function calculateThreadCostSummary(
  threadId: ThreadId,
  projections: ReadonlyMap<ThreadId, ThreadCostProjection>,
  settings: ThreadCostSettings,
): OrchestrationV2ThreadCostSummary | null {
  const ratesByInstance = new Map<ProviderInstanceId, RateTable>();
  const overrides = createOverrideRateTable(settings.usagePriceOverrides);
  const rateTableFor = (instanceId: ProviderInstanceId): RateTable => {
    const cached = ratesByInstance.get(instanceId);
    if (cached !== undefined) return cached;
    const instance = settings.providerInstances[instanceId];
    const rates = createGatewayRateTable(
      instance === undefined ? [] : aixGatewayModelPrices({ [instanceId]: instance }),
    );
    ratesByInstance.set(instanceId, rates);
    return rates;
  };

  const ownCost = (projection: ThreadCostProjection): number | null => {
    const providerThreads = new Map(
      projection.providerThreads.map((thread) => [thread.id, thread]),
    );
    const providerSessions = new Map(
      projection.providerSessions.map((session) => [session.id, session]),
    );
    let totalCostUsd = 0;

    for (const turn of projection.providerTurns) {
      const usage = turn.turnTokenUsage;
      if (usage === undefined) return null;
      if (usage.usageStatus === "unavailable") {
        if (usage.localCommand) continue;
        return null;
      }

      const cachedInputTokens = usage.cachedInputTokens ?? 0;
      const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
      const otherInputTokens = usage.otherUsage?.inputTokens ?? 0;
      const inputTokens = (usage.inputTokens ?? 0) + otherInputTokens;
      const outputTokens = (usage.outputTokens ?? 0) + (usage.otherUsage?.outputTokens ?? 0);
      if (inputTokens + outputTokens === 0) continue;

      const providerThread = providerThreads.get(turn.providerThreadId);
      const providerInstanceId = providerThread?.providerInstanceId;
      const sessionModel =
        providerThread?.providerSessionId == null
          ? null
          : (providerSessions.get(providerThread.providerSessionId)?.model ?? null);
      const model =
        turn.model ?? (usage.models?.length === 1 ? usage.models[0] : undefined) ?? sessionModel;
      if (providerInstanceId === undefined || model === undefined || model === null) return null;

      const priced = priceUsage(
        rateTableFor(providerInstanceId),
        {
          model,
          speed: "standard",
          reportedCostUsd: null,
          cacheCreation1hTokens: 0,
          totals: {
            uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
            cachedInputTokens,
            cacheCreationTokens,
            outputTokens,
            reasoningTokens: usage.reasoningTokens ?? 0,
          },
        },
        overrides,
      );
      if (priced.costSource === "unpriced") return null;
      totalCostUsd += priced.costUsd;
    }

    return totalCostUsd;
  };

  const resolving = new Set<ThreadId>();
  const summaries = new Map<ThreadId, OrchestrationV2ThreadCostSummary | null>();
  const summarize = (currentThreadId: ThreadId): OrchestrationV2ThreadCostSummary | null => {
    if (summaries.has(currentThreadId)) return summaries.get(currentThreadId) ?? null;
    if (resolving.has(currentThreadId)) return null;
    const projection = projections.get(currentThreadId);
    if (projection === undefined) return null;

    resolving.add(currentThreadId);
    const mainThreadCostUsd = ownCost(projection);
    if (mainThreadCostUsd === null) {
      resolving.delete(currentThreadId);
      summaries.set(currentThreadId, null);
      return null;
    }

    const seenChildren = new Set<ThreadId>();
    const subagents: Array<OrchestrationV2ThreadCostSummary["subagents"][number]> = [];
    let totalCostUsd = mainThreadCostUsd;
    for (const subagent of projection.subagents) {
      if (subagent.origin !== "app_owned") continue;
      if (subagent.childThreadId === null) {
        if (subagent.remoteChild !== undefined) {
          resolving.delete(currentThreadId);
          summaries.set(currentThreadId, null);
          return null;
        }
        continue;
      }
      if (seenChildren.has(subagent.childThreadId)) continue;
      seenChildren.add(subagent.childThreadId);

      const childProjection = projections.get(subagent.childThreadId);
      const childSummary = summarize(subagent.childThreadId);
      if (childProjection === undefined || childSummary === null) {
        resolving.delete(currentThreadId);
        summaries.set(currentThreadId, null);
        return null;
      }
      const title = subagent.title?.trim() || childProjection.thread.title.trim() || "Subagent";
      subagents.push({
        threadId: subagent.childThreadId,
        title,
        costUsd: childSummary.totalCostUsd,
      });
      totalCostUsd += childSummary.totalCostUsd;
    }

    const summary = { totalCostUsd, mainThreadCostUsd, subagents };
    resolving.delete(currentThreadId);
    summaries.set(currentThreadId, summary);
    return summary;
  };

  return summarize(threadId);
}
