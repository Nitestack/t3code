import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { filterByEnvironmentScope, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import {
  filterEnvironmentIdsByScope,
  filterThreadKeysByEnvironmentScope,
} from "./environmentScope";

describe("filterEnvironmentIdsByScope", () => {
  it("filters by environment identity when project names and paths overlap", () => {
    const workEnvironmentId = EnvironmentId.make("environment-work");
    const personalEnvironmentId = EnvironmentId.make("environment-personal");
    const environmentIds = [workEnvironmentId, personalEnvironmentId];
    const projects = [
      { environmentId: workEnvironmentId, title: "repo", workspaceRoot: "/projects/repo" },
      { environmentId: personalEnvironmentId, title: "repo", workspaceRoot: "/projects/repo" },
    ];
    const assignments = {
      [workEnvironmentId]: "work",
      [personalEnvironmentId]: "personal",
    } as const;

    expect(filterEnvironmentIdsByScope(environmentIds, "work", assignments)).toEqual([
      workEnvironmentId,
    ]);
    expect(filterEnvironmentIdsByScope(environmentIds, "personal", assignments)).toEqual([
      personalEnvironmentId,
    ]);
    expect(filterByEnvironmentScope(projects, "work", assignments)).toEqual([projects[0]]);
    expect(filterByEnvironmentScope(projects, "personal", assignments)).toEqual([projects[1]]);

    const workThread = { environmentId: workEnvironmentId, threadId: ThreadId.make("same-id") };
    const personalThread = {
      environmentId: personalEnvironmentId,
      threadId: ThreadId.make("same-id"),
    };
    const staleSelection = [
      scopedThreadKey(workThread),
      scopedThreadKey(personalThread),
      "invalid",
    ];
    expect(filterThreadKeysByEnvironmentScope(staleSelection, "personal", assignments)).toEqual([
      personalThread,
    ]);
    expect(filterThreadKeysByEnvironmentScope(staleSelection, "work", assignments)).toEqual([
      workThread,
    ]);
  });
});
