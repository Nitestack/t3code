import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  filterMobileProjectScope,
  filterMobileThreadScope,
  isAndroidForkEnvironmentScopeEnabled,
  routeEnvironmentScope,
  mobileScopeSearchEnvironmentIds,
} from "./mobile-environment-scope";

describe("mobile project scope", () => {
  it("keeps every environment available to search and selection", () => {
    const work = EnvironmentId.make("work-server");
    const personal = EnvironmentId.make("personal-server");
    const input = {
      environments: [
        { environmentId: work, connectionState: "connected" },
        { environmentId: personal, connectionState: "connected" },
        { environmentId: EnvironmentId.make("offline"), connectionState: "offline" },
      ],
      selectedEnvironmentId: null,
    };
    expect(mobileScopeSearchEnvironmentIds(input)).toEqual([work, personal]);
    expect(mobileScopeSearchEnvironmentIds({ ...input, selectedEnvironmentId: work })).toEqual([
      work,
    ]);
  });

  it("filters project and thread lists using each project's scope", () => {
    const environmentId = EnvironmentId.make("shared-server");
    const workId = ProjectId.make("work-project");
    const personalId = ProjectId.make("personal-project");
    const projects = [
      { environmentId, id: workId, scope: "work" as const },
      { environmentId, id: personalId },
    ];
    const threads = [
      { environmentId, projectId: workId, id: "work-thread" },
      { environmentId, projectId: personalId, id: "personal-thread" },
    ];
    expect(filterMobileProjectScope(projects, true, "work")).toEqual([projects[0]]);
    expect(filterMobileThreadScope(threads, true, "work", projects)).toEqual([threads[0]]);
    expect(filterMobileProjectScope(projects, false, "work")).toBe(projects);
  });

  it("resolves navigation from a project's persisted scope", () => {
    expect(routeEnvironmentScope({ enabled: true, projectScope: "work" })).toBe("work");
    expect(routeEnvironmentScope({ enabled: true, projectScope: undefined })).toBe("personal");
    expect(routeEnvironmentScope({ enabled: true, projectScope: null })).toBeNull();
    expect(routeEnvironmentScope({ enabled: false, projectScope: "work" })).toBeNull();
    expect(
      isAndroidForkEnvironmentScopeEnabled({ platformOS: "android", appVariant: "android-fork" }),
    ).toBe(true);
  });
});
