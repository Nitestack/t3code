import { createModelLaneRequestAtoms } from "@t3tools/client-runtime/state/modelLaneRequests";

import { connectionAtomRuntime } from "../connection/runtime";

export const modelLaneRequestEnvironment = createModelLaneRequestAtoms(connectionAtomRuntime);
