import { describe, expect, it } from "vite-plus/test";
import type { ModelLaneProject } from "@t3tools/shared/modelLanes";
import { aixProfileLabels, laneLabel, sendLanesNeedingConfirm } from "./modelLanes.logic";

const personal: ModelLaneProject = { scope: "personal" };
const work: ModelLaneProject = { scope: "work", homeAixProfile: "adcare" };
const workNoHome: ModelLaneProject = { scope: "work", homeAixProfile: null };

describe("sendLanesNeedingConfirm", () => {
  it.each([
    {
      name: "draft in a personal project sends on personal",
      project: personal,
      thread: null,
      instanceIds: ["codex"],
      expected: [],
    },
    {
      name: "draft in a personal project sends on a work key",
      project: personal,
      thread: null,
      instanceIds: ["aix-codex-adcare"],
      expected: ["aix:adcare"],
    },
    {
      name: "draft in a work project sends on its home key",
      project: work,
      thread: null,
      instanceIds: ["aix-codex-adcare"],
      expected: [],
    },
    {
      name: "draft in a work project sends on personal",
      project: work,
      thread: null,
      instanceIds: ["codex"],
      expected: ["personal"],
    },
    {
      name: "work project without a home key only allows granted lanes",
      project: workNoHome,
      thread: null,
      instanceIds: ["aix-codex-adcare"],
      expected: ["aix:adcare"],
    },
    {
      name: "thread already granted the lane sends without asking",
      project: work,
      thread: { allowedLanes: ["personal"], modelSelection: { instanceId: "codex" } },
      instanceIds: ["codex"],
      expected: [],
    },
    {
      name: "thread without that grant asks",
      project: work,
      thread: { allowedLanes: ["personal"], modelSelection: { instanceId: "codex" } },
      instanceIds: ["aix-codex-loom"],
      expected: ["aix:loom"],
    },
    {
      name: "legacy thread keeps the lane of its current model",
      project: work,
      thread: { modelSelection: { instanceId: "codex" } },
      instanceIds: ["codex"],
      expected: [],
    },
    {
      name: "legacy thread asks before moving to another lane",
      project: work,
      thread: { modelSelection: { instanceId: "aix-codex-loom" } },
      instanceIds: ["codex"],
      expected: ["personal"],
    },
    {
      name: "multi-model send lists each unallowed lane once",
      project: personal,
      thread: null,
      instanceIds: ["codex", "aix-codex-adcare", "aix-codex-loom", "aix-codex-loom"],
      expected: ["aix:adcare", "aix:loom"],
    },
  ])("$name", ({ project, thread, instanceIds, expected }) => {
    expect(sendLanesNeedingConfirm({ project, thread, instanceIds })).toEqual(expected);
  });
});

describe("laneLabel", () => {
  it.each([
    ["personal", "Personal"],
    ["aix:p", "Work · Persönlich"],
    ["aix:adcare", "Work · adcare"],
  ] as const)("labels %s as %s", (lane, label) => {
    expect(
      laneLabel(lane, aixProfileLabels([{ aixProfile: "p", aixProfileLabel: "Persönlich" }])),
    ).toBe(label);
  });
});
