import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell } from "./shell";
import { environmentThreadDetails } from "./threads";

export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime, {
  shellState: environmentShell.stateValueAtom,
});

export const threadTitlesRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:orchestration:thread-titles-read",
  tag: ORCHESTRATION_V2_WS_METHODS.getThreadTitles,
});

export const threadCostRead = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:orchestration:thread-cost",
  tag: ORCHESTRATION_V2_WS_METHODS.getThreadCost,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger: ({ environmentId, input }) =>
    Atom.make((get) => {
      const thread = get(
        environmentThreadDetails.quietThreadAtom({ environmentId, threadId: input.threadId }),
      );
      const projection = thread?.projection;
      if (projection === undefined || projection === null) return null;
      // Settled turns only: streaming usage would refetch the whole subagent tree per tick.
      return JSON.stringify({
        turns: projection.providerTurns.flatMap((turn) =>
          turn.status === "pending" || turn.status === "running"
            ? []
            : [[turn.id, turn.status, turn.model, turn.turnTokenUsage]],
        ),
        subagents: projection.subagents.map((subagent) => [
          subagent.id,
          subagent.childThreadId,
          subagent.title,
          subagent.status,
        ]),
      });
    }),
});
