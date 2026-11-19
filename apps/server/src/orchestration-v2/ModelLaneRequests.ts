import {
  CommandId,
  MessageId,
  ModelLaneRequestAnswerInput,
  ModelLaneRequestError,
  OrchestratorMcpFailure,
  ThreadId,
  TurnItemId,
  type OrchestratorMcpRequestModelLaneInput,
  type OrchestratorMcpRequestModelLaneResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { isLaneAllowed, laneOfInstance, threadAllowedLanes } from "@t3tools/shared/modelLanes";

export class ModelLaneRequests extends Context.Service<
  ModelLaneRequests,
  {
    readonly request: (
      scope: McpInvocationContext.McpInvocationScope,
      input: OrchestratorMcpRequestModelLaneInput,
    ) => Effect.Effect<OrchestratorMcpRequestModelLaneResult, OrchestratorMcpFailure>;
    readonly answer: (
      input: ModelLaneRequestAnswerInput,
    ) => Effect.Effect<void, ModelLaneRequestError>;
  }
>()("t3/orchestration-v2/ModelLaneRequests") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const answerLocks = yield* KeyedLock.make<TurnItemId>();

  const request: ModelLaneRequests["Service"]["request"] = Effect.fn("ModelLaneRequests.request")(
    function* (scope, input) {
      const threadScope = yield* McpInvocationContext.requireThreadScope(
        scope,
        "request_model_lane",
      );
      const threadId = threadScope.thread.threadId;
      const records = yield* threadManagement
        .getThreadRecords(threadId, ["runs"], { messageRoles: [] })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: `Could not read the calling thread: ${error.message}`,
              }),
          ),
        );
      const run = ThreadManagementService.latestActiveRun(records);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== threadScope.thread.providerInstanceId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message:
            "Requesting a provider lane requires an active run owned by this provider session.",
        });
      }
      const providers = yield* providerRegistry.getProviders;
      const provider = providers.find(
        (candidate) => candidate.instanceId === input.providerInstanceId,
      );
      if (provider === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "provider_unavailable",
          message: `Provider ${input.providerInstanceId} is not available in this environment.`,
        });
      }
      const projectOption = yield* projects
        .getById(records.thread.projectId)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      if (Option.isNone(projectOption)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Project ${records.thread.projectId} was not found.`,
        });
      }
      const lane = laneOfInstance(provider);
      if (isLaneAllowed(projectOption.value, threadAllowedLanes(records.thread), lane)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Lane ${lane} is already allowed for this thread; launch the task directly.`,
        });
      }
      const turnItemId = TurnItemId.make(`turn-item:lane-request:${yield* random.uuidV4()}`);
      const providerLabel = provider.displayName ?? provider.instanceId;
      yield* threadManagement
        .dispatch({
          type: "lane_request.record",
          commandId: CommandId.make(`model-lane-request:${turnItemId}:pending`),
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          turnItemId,
          lane,
          providerInstanceId: provider.instanceId,
          providerLabel,
          reason: input.reason,
          requestedFor: input.for,
          laneStatus: "pending",
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: `Could not record the provider lane request: ${error.message}`,
              }),
          ),
        );
      return { status: "pending", turnItemId };
    },
  );

  const readCard = (threadId: ThreadId, turnItemId: TurnItemId) =>
    threadManagement
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["lane_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.map((records) => {
          const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
          return item?.type === "lane_request" && records.thread.deletedAt === null
            ? item
            : undefined;
        }),
      );

  const answer: ModelLaneRequests["Service"]["answer"] = Effect.fn("ModelLaneRequests.answer")(
    function* (input) {
      yield* answerLocks.withLock(
        input.turnItemId,
        Effect.gen(function* () {
          const card = yield* readCard(input.threadId, input.turnItemId).pipe(
            Effect.mapError((cause) => new ModelLaneRequestError({ reason: "load_failed", cause })),
          );
          if (card === undefined || card.runId === null || card.nodeId === null) {
            return yield* new ModelLaneRequestError({ reason: "not_found" });
          }
          if (card.laneStatus !== "pending") {
            return yield* new ModelLaneRequestError({ reason: "already_answered" });
          }
          const laneStatus =
            input.answer.type === "allow-task"
              ? "allowed_task"
              : input.answer.type === "allow-thread"
                ? "allowed_thread"
                : "denied";
          const response =
            laneStatus === "allowed_task"
              ? `The user allowed one child launch on lane ${card.lane}. Launch the requested child now; this grant will be consumed once.`
              : laneStatus === "allowed_thread"
                ? `The user allowed lane ${card.lane} for this thread. You may now launch work on that lane.`
                : `The user denied access to lane ${card.lane}. Continue with an allowed provider or ask the user directly.`;
          yield* threadManagement
            .dispatch({
              type: "lane_request.record",
              commandId: CommandId.make(`model-lane-request:${card.id}:${laneStatus}`),
              threadId: input.threadId,
              runId: card.runId,
              nodeId: card.nodeId,
              turnItemId: card.id,
              lane: card.lane,
              providerInstanceId: card.providerInstanceId,
              providerLabel: card.providerLabel,
              reason: card.reason,
              requestedFor: card.requestedFor,
              laneStatus,
              wake: {
                messageId: MessageId.make(`message:model-lane-request:${card.id}`),
                text: response,
                notification: {
                  source: { kind: "background_task" },
                  outcome: laneStatus === "denied" ? "cancelled" : "completed",
                  summary:
                    laneStatus === "denied"
                      ? `Denied lane ${card.lane}`
                      : `Allowed lane ${card.lane}`,
                },
              },
            })
            .pipe(
              Effect.mapError(
                (cause) => new ModelLaneRequestError({ reason: "record_failed", cause }),
              ),
            );
        }),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.withSpan("ModelLaneRequests.answer", { attributes: { threadId: input.threadId } }),
      ),
  );

  return ModelLaneRequests.of({ request, answer });
});

export const layer = Layer.effect(ModelLaneRequests, make);
