import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { NodeId, ProviderInstanceId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ModelLaneRequests from "./ModelLaneRequests.ts";

const threadId = ThreadId.make("thread:model-lane-request");
const runId = RunId.make("run:model-lane-request");
const nodeId = NodeId.make("node:model-lane-request");
const turnItemId = TurnItemId.make("turn-item:model-lane-request");
const providerInstanceId = ProviderInstanceId.make("aix-codex-work");
const card = {
  id: turnItemId,
  type: "lane_request",
  runId,
  nodeId,
  lane: "aix:work",
  providerInstanceId,
  providerLabel: "AIX Work",
  reason: "The personal provider is out of quota.",
  requestedFor: "task",
  laneStatus: "pending",
} as never;

it.effect.each([
  [{ type: "allow-task" }, "allowed_task", "completed"],
  [{ type: "allow-thread" }, "allowed_thread", "completed"],
  [{ type: "deny" }, "denied", "cancelled"],
] as const)("answers a lane request with %o", ([answer, laneStatus, outcome]) => {
  const dispatched: Array<unknown> = [];
  const layer = ModelLaneRequests.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({ thread: { deletedAt: null }, turnItems: [card] }) as never,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return {};
            }) as never,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProjectService.ProjectService)({}),
      ),
    ),
  );

  return Effect.gen(function* () {
    const requests = yield* ModelLaneRequests.ModelLaneRequests;
    yield* requests.answer({ threadId, turnItemId, answer });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "lane_request.record",
      threadId,
      runId,
      nodeId,
      turnItemId,
      lane: "aix:work",
      providerInstanceId,
      laneStatus,
      wake: {
        notification: { outcome },
      },
    });
  }).pipe(Effect.provide(layer));
});
