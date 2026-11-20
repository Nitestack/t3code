import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";

import { calculateThreadCostSummary, type ThreadCostProjection } from "./threadCost.ts";

const instanceId = ProviderInstanceId.make("aix-codex-work");
const model = "gpt-6.1-sol";
const settings = {
  providerInstances: {
    [instanceId]: {
      driver: ProviderDriverKind.make("codex"),
      config: {
        aixProfile: "work",
        customModels: [
          {
            slug: model,
            catalogMetadata: {
              pricing: {
                inputPerMillionTokens: 1,
                outputPerMillionTokens: 3,
                cachedInputPerMillionTokens: 0.2,
                cacheWritePerMillionTokens: 1.5,
              },
            },
          },
        ],
      },
    },
  },
  usagePriceOverrides: {},
};

function projection(
  threadId: ThreadId,
  title: string,
  inputTokens = 100,
  outputTokens = 10,
): ThreadCostProjection {
  const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
  return {
    thread: { id: threadId, title },
    subagents: [],
    providerTurns: [
      {
        providerThreadId,
        model,
        turnTokenUsage: {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens,
          outputTokens,
          hasSubagents: false,
        },
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        providerInstanceId: instanceId,
        providerSessionId: ProviderSessionId.make(`provider-session:${threadId}`),
      },
    ],
    providerSessions: [],
  };
}

it("prices cached tokens and provider-ledger subagent usage with the AIX model rates", () => {
  const rootId = ThreadId.make("thread:cost-root");
  const root = projection(rootId, "Main", 1000, 50);
  const [turn] = root.providerTurns;
  const records = new Map<ThreadId, ThreadCostProjection>([
    [
      rootId,
      {
        ...root,
        providerTurns: [
          {
            ...turn!,
            turnTokenUsage: {
              ...turn!.turnTokenUsage!,
              cachedInputTokens: 200,
              cacheCreationTokens: 100,
              hasSubagents: true,
              otherUsage: { inputTokens: 100, outputTokens: 10 },
            },
          },
        ],
      },
    ],
  ]);

  expect(calculateThreadCostSummary(rootId, records, settings)?.mainThreadCostUsd).toBeCloseTo(
    0.00117,
  );
});

it("deduplicates child threads and adds nested subagent totals to their parent row", () => {
  const rootId = ThreadId.make("thread:cost-root");
  const researchId = ThreadId.make("thread:cost-research");
  const reviewId = ThreadId.make("thread:cost-review");
  const nestedId = ThreadId.make("thread:cost-nested");
  const root = projection(rootId, "Main");
  const research = projection(researchId, "Research");
  const review = projection(reviewId, "Code review");
  const nested = projection(nestedId, "Search sources");
  const records = new Map<ThreadId, ThreadCostProjection>([
    [
      rootId,
      {
        ...root,
        subagents: [
          { origin: "app_owned", childThreadId: researchId, title: "Research" },
          { origin: "app_owned", childThreadId: researchId, title: "Research resumed" },
          { origin: "app_owned", childThreadId: reviewId, title: "Code review" },
        ],
      },
    ],
    [
      researchId,
      {
        ...research,
        subagents: [{ origin: "app_owned", childThreadId: nestedId, title: "Search sources" }],
      },
    ],
    [reviewId, review],
    [nestedId, nested],
  ]);

  const summary = calculateThreadCostSummary(rootId, records, settings);
  expect(summary?.totalCostUsd).toBeCloseTo(0.00052, 10);
  expect(summary?.mainThreadCostUsd).toBeCloseTo(0.00013, 10);
  expect(summary?.subagents).toEqual([
    { threadId: researchId, title: "Research", costUsd: expect.any(Number) },
    { threadId: reviewId, title: "Code review", costUsd: expect.any(Number) },
  ]);
  expect(summary?.subagents[0]?.costUsd).toBeCloseTo(0.00026, 10);
  expect(summary?.subagents[1]?.costUsd).toBeCloseTo(0.00013, 10);
});

it("does not return a total when an AIX model has no configured price", () => {
  const rootId = ThreadId.make("thread:cost-unpriced");
  const unpriced = {
    ...projection(rootId, "Unpriced"),
    providerTurns: [
      {
        ...projection(rootId, "Unpriced").providerTurns[0]!,
        model: "not-in-the-gateway-catalog",
      },
    ],
  };

  expect(calculateThreadCostSummary(rootId, new Map([[rootId, unpriced]]), settings)).toBeNull();
});

it("does not return a total when a local tree includes an unpriced remote child", () => {
  const rootId = ThreadId.make("thread:cost-remote-root");
  const root = projection(rootId, "Main");
  const remoteProjection: ThreadCostProjection = {
    ...root,
    subagents: [
      {
        origin: "app_owned" as const,
        childThreadId: null,
        title: "Remote research",
        remoteChild: {
          environmentId: EnvironmentId.make("environment:remote"),
          threadId: ThreadId.make("thread:remote-research"),
          label: "Research",
        },
      },
    ],
  };

  expect(
    calculateThreadCostSummary(rootId, new Map([[rootId, remoteProjection]]), settings),
  ).toBeNull();
});
