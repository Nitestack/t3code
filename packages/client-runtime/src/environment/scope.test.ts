import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import {
  filterByProjectScope,
  filterProjectsByScope,
  resolveActiveEnvironmentScope,
  resolveProjectScope,
} from "./scope.ts";

describe("project scope", () => {
  const environmentId = EnvironmentId.make("shared-server");
  const workProjectId = ProjectId.make("work-project");
  const personalProjectId = ProjectId.make("personal-project");

  it("filters projects and their threads by project scope", () => {
    const projects = [
      { environmentId, id: workProjectId, scope: "work" as const },
      { environmentId, id: personalProjectId },
    ];
    const threads = [
      { environmentId, projectId: workProjectId, id: ThreadId.make("work-thread") },
      { environmentId, projectId: personalProjectId, id: ThreadId.make("personal-thread") },
    ];

    expect(filterProjectsByScope(projects, "work")).toEqual([projects[0]]);
    expect(filterProjectsByScope(projects, "personal")).toEqual([projects[1]]);
    expect(filterByProjectScope(threads, "work", projects)).toEqual([threads[0]]);
    expect(filterByProjectScope(threads, "personal", projects)).toEqual([threads[1]]);
  });

  it("keeps same project IDs distinct across environments", () => {
    const sameProjectId = ProjectId.make("same-project");
    const projects = [
      { environmentId, id: sameProjectId, scope: "work" as const },
      { environmentId: EnvironmentId.make("other-server"), id: sameProjectId },
    ];
    const threads = projects.map((project, index) => ({
      environmentId: project.environmentId,
      projectId: sameProjectId,
      id: ThreadId.make(`thread-${index}`),
    }));
    expect(filterByProjectScope(threads, "work", projects)).toEqual([threads[0]]);
  });

  it("defaults a missing project scope and invalid active scope to personal", () => {
    expect(resolveProjectScope(undefined)).toBe("personal");
    expect(resolveProjectScope("unknown")).toBe("personal");
    expect(resolveActiveEnvironmentScope(undefined)).toBe("personal");
    expect(resolveActiveEnvironmentScope("unknown")).toBe("personal");
    expect(resolveActiveEnvironmentScope("work")).toBe("work");
  });
});
