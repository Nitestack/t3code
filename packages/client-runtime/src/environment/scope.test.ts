import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import {
  assignEnvironmentScope,
  filterByEnvironmentScope,
  getEnvironmentScope,
  normalizeEnvironmentScopeAssignments,
  resolveActiveEnvironmentScope,
} from "./scope.ts";

describe("environment scope preferences", () => {
  const workEnvironmentId = EnvironmentId.make("work-server");
  const personalEnvironmentId = EnvironmentId.make("personal-server");

  it("defaults unclassified environments to personal and filters by stable environment id", () => {
    const assignments = { [workEnvironmentId]: "work" as const };
    const environments = [
      { environmentId: workEnvironmentId, label: "Personal" },
      { environmentId: personalEnvironmentId, label: "Work" },
    ];

    expect(getEnvironmentScope(assignments, personalEnvironmentId)).toBe("personal");
    expect(filterByEnvironmentScope(environments, "work", assignments)).toEqual([environments[0]]);
    expect(filterByEnvironmentScope(environments, "personal", assignments)).toEqual([
      environments[1],
    ]);
  });

  it("defaults an unset or invalid active scope to personal", () => {
    expect(resolveActiveEnvironmentScope(undefined)).toBe("personal");
    expect(resolveActiveEnvironmentScope("other")).toBe("personal");
    expect(resolveActiveEnvironmentScope("work")).toBe("work");
  });

  it("keeps same-path project and thread references distinct across environments", () => {
    const projectId = ProjectId.make("same-project");
    const threadId = ThreadId.make("same-thread");
    const projects = [
      { environmentId: workEnvironmentId, projectId, path: "/repo" },
      { environmentId: personalEnvironmentId, projectId, path: "/repo" },
    ];
    const threads = [
      { environmentId: workEnvironmentId, threadId },
      { environmentId: personalEnvironmentId, threadId },
    ];
    const assignments = { [workEnvironmentId]: "work" as const };

    expect(filterByEnvironmentScope(projects, "work", assignments)).toEqual([projects[0]]);
    expect(filterByEnvironmentScope(threads, "work", assignments)).toEqual([threads[0]]);
    expect(projects).toHaveLength(2);
    expect(threads).toHaveLength(2);
  });

  it("updates only the selected environment assignment", () => {
    const assignments = {
      [workEnvironmentId]: "work" as const,
      [personalEnvironmentId]: "personal" as const,
    };

    expect(assignEnvironmentScope(assignments, workEnvironmentId, "personal")).toEqual({
      [workEnvironmentId]: "personal",
      [personalEnvironmentId]: "personal",
    });
    expect(assignments[workEnvironmentId]).toBe("work");
  });

  it("drops invalid persisted classifications without promoting them to work", () => {
    const assignments = normalizeEnvironmentScopeAssignments({
      [workEnvironmentId]: "work",
      [personalEnvironmentId]: "unknown",
      invalid: null,
    });

    expect(assignments).toEqual({ [workEnvironmentId]: "work" });
    expect(getEnvironmentScope(assignments, personalEnvironmentId)).toBe("personal");
    expect(normalizeEnvironmentScopeAssignments(["work"])).toEqual({});
  });
});
