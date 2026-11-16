import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  resolveNewThreadModelSelectionOverride,
  resolveThreadActionProjectRef,
} from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};
const WORK_CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("aix-codex-team"),
  model: "work-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });

  it("carries a route model only when it belongs to the destination scope", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: null,
        destinationDraftId: "draft-new",
        scope: "personal",
        providers: [{ instanceId: CARRIED_SELECTION.instanceId }],
      }),
    ).toEqual(CARRIED_SELECTION);
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: WORK_CARRIED_SELECTION,
        carrySourceDraftId: null,
        destinationDraftId: "draft-new",
        scope: "personal",
        providers: [{ instanceId: WORK_CARRIED_SELECTION.instanceId }],
      }),
    ).toBeNull();
  });

  it("uses the selected scope's project when the open thread belongs to another scope", () => {
    const workEnvironmentId = EnvironmentId.make("environment-work");
    const personalEnvironmentId = EnvironmentId.make("environment-personal");
    const workProjectRef = scopeProjectRef(workEnvironmentId, ProjectId.make("work-project"));

    expect(
      resolveThreadActionProjectRef({
        activeDraftThread: null,
        activeThread: { environmentId: personalEnvironmentId, projectId: ProjectId.make("same") },
        defaultProjectRef: workProjectRef,
        environmentScope: {
          activeScope: "work",
          projects: [
            { environmentId: workEnvironmentId, id: workProjectRef.projectId, scope: "work" },
            {
              environmentId: personalEnvironmentId,
              id: ProjectId.make("same"),
              scope: "personal",
            },
          ],
        },
        handleNewThread: async () => null,
      }),
    ).toEqual(workProjectRef);
  });
});
