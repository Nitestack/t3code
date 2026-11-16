import { describe, expect, it } from "vite-plus/test";

import { projectScopeInput, supportsProjectScope } from "./projectScope.ts";

describe("project scope capability", () => {
  it("does not infer project scope support from project organization", () => {
    const capabilities = { projectOrganization: true };

    expect(supportsProjectScope(capabilities)).toBe(false);
    expect(projectScopeInput(capabilities, "work")).toEqual({});
  });

  it("includes scope when the environment supports it", () => {
    const capabilities = { projectScope: true };

    expect(supportsProjectScope(capabilities)).toBe(true);
    expect(projectScopeInput(capabilities, "work")).toEqual({ scope: "work" });
  });
});
