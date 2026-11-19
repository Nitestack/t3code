import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";

/** The user's response to a provider lane request card. */
export const ModelLaneRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("allow-task") }),
    Schema.Struct({ type: Schema.Literal("allow-thread") }),
    Schema.Struct({ type: Schema.Literal("deny") }),
  ]),
});
export type ModelLaneRequestAnswerInput = typeof ModelLaneRequestAnswerInput.Type;

const MODEL_LANE_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the provider lane request.",
  not_found: "This provider lane request no longer exists.",
  already_answered: "This provider lane request was already answered.",
  record_failed: "Could not update the provider lane request.",
} as const;

export const ModelLaneRequestFailureReason = Schema.Literals(
  Object.keys(MODEL_LANE_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof MODEL_LANE_REQUEST_FAILURE_MESSAGES
  >,
);
export type ModelLaneRequestFailureReason = typeof ModelLaneRequestFailureReason.Type;

export class ModelLaneRequestError extends Schema.TaggedError<ModelLaneRequestError>()(
  "ModelLaneRequestError",
  {
    reason: ModelLaneRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return MODEL_LANE_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
