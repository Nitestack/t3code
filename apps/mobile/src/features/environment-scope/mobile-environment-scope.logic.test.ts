import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import {
  filterMobileEnvironmentScope,
  isAndroidForkEnvironmentScopeEnabled,
  routeEnvironmentScope,
} from "./mobile-environment-scope";

describe("mobile environment scope", () => {
  it("filters same-named project paths by environment id only for the Android fork", () => {
    const projects = [
      { environmentId: EnvironmentId.make("work-server"), title: "repo", workspaceRoot: "/repo" },
      {
        environmentId: EnvironmentId.make("personal-server"),
        title: "repo",
        workspaceRoot: "/repo",
      },
    ];
    const assignments = { "work-server": "work", "personal-server": "personal" } as const;

    expect(filterMobileEnvironmentScope(projects, true, "work", assignments)).toEqual([
      projects[0],
    ]);
    expect(filterMobileEnvironmentScope(projects, true, "personal", assignments)).toEqual([
      projects[1],
    ]);
  });

  it("leaves official Android and iOS behavior unchanged", () => {
    const values = [{ environmentId: EnvironmentId.make("work-server") }];

    expect(
      isAndroidForkEnvironmentScopeEnabled({ platformOS: "android", appVariant: "android-fork" }),
    ).toBe(true);
    expect(
      isAndroidForkEnvironmentScopeEnabled({ platformOS: "android", appVariant: "production" }),
    ).toBe(false);
    expect(
      isAndroidForkEnvironmentScopeEnabled({ platformOS: "ios", appVariant: "android-fork" }),
    ).toBe(false);
    expect(filterMobileEnvironmentScope(values, false, "personal", { "work-server": "work" })).toBe(
      values,
    );
    expect(
      routeEnvironmentScope({
        enabled: false,
        environmentId: values[0]!.environmentId,
        assignments: { "work-server": "work" },
      }),
    ).toBeNull();
  });

  it("resolves direct navigation to the route environment's scope", () => {
    expect(
      routeEnvironmentScope({
        enabled: true,
        environmentId: EnvironmentId.make("work-server"),
        assignments: { "work-server": "work" },
      }),
    ).toBe("work");
    expect(
      routeEnvironmentScope({
        enabled: true,
        environmentId: EnvironmentId.make("new-environment"),
        assignments: {},
      }),
    ).toBe("personal");
  });
});
