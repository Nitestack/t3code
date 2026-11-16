import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { filterProjectsForScope, filterThreadsForScope } from "./environmentScope";

describe("project scope filters", () => {
  it("filters project and thread rows by scope while sharing an environment", () => {
    const environmentId = EnvironmentId.make("shared-server");
    const workProjectId = ProjectId.make("work-project");
    const personalProjectId = ProjectId.make("personal-project");
    const projects = [
      { environmentId, id: workProjectId, scope: "work" as const },
      { environmentId, id: personalProjectId },
    ];
    const threads = [
      { environmentId, projectId: workProjectId, id: ThreadId.make("work-thread") },
      { environmentId, projectId: personalProjectId, id: ThreadId.make("personal-thread") },
    ];
    expect(filterProjectsForScope(projects, "work")).toEqual([projects[0]]);
    expect(filterThreadsForScope(threads, "personal", projects)).toEqual([threads[1]]);
  });
});
