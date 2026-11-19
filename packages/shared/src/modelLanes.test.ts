import { describe, expect, it } from "@effect/vitest";

import {
  allowedLanesForProject,
  isLaneAllowed,
  laneOfInstance,
  projectHomeLane,
} from "./modelLanes.ts";

describe("model lanes", () => {
  it.each([
    ["non aix instance", undefined, "personal"],
    ["aix profile", "work-1", "aix:work-1"],
  ] as const)("classifies a %s", (_, aixProfile, expected) => {
    expect(laneOfInstance(aixProfile === undefined ? {} : { aixProfile })).toBe(expected);
  });

  it.each([
    ["unscoped project", {}, "personal"],
    ["Personal project", { scope: "personal" }, "personal"],
    ["Work project with home", { scope: "work", homeAixProfile: "work-1" }, "aix:work-1"],
    ["Work project without home", { scope: "work" }, null],
  ] as const)("resolves the home lane for a %s", (_, project, expected) => {
    expect(projectHomeLane(project)).toBe(expected);
  });

  it("allows the project home and approved lanes", () => {
    const project = { scope: "work", homeAixProfile: "work-1" } as const;
    expect(isLaneAllowed(project, ["aix:work-2"], "aix:work-1")).toBe(true);
    expect(isLaneAllowed(project, ["aix:work-2"], "aix:work-2")).toBe(true);
    expect(isLaneAllowed(project, ["aix:work-2"], "personal")).toBe(false);
    expect(allowedLanesForProject(project, ["aix:work-2"])).toEqual(["aix:work-1", "aix:work-2"]);
  });
});
