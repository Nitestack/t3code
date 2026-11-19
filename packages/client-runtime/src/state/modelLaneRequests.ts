import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createModelLaneRequestAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // An agent's lane card. One answer per card at a time.
    answer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:model-lane-requests:answer",
      tag: WS_METHODS.modelLaneRequestAnswer,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnItemId]),
      },
    }),
  };
}
