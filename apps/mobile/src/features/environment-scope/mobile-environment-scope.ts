import {
  filterByProjectScope,
  filterProjectsByScope,
  resolveProjectScope,
  type EnvironmentScope,
  type ScopedProject,
  type ScopedProjectThread,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";

export function isAndroidForkEnvironmentScopeEnabled(input: {
  readonly platformOS: string;
  readonly appVariant: unknown;
}): boolean {
  return input.platformOS === "android" && input.appVariant === "android-fork";
}

export function filterMobileProjectScope<T extends ScopedProject>(
  projects: ReadonlyArray<T>,
  enabled: boolean,
  scope: EnvironmentScope,
): ReadonlyArray<T> {
  return enabled ? filterProjectsByScope(projects, scope) : projects;
}

export function filterMobileThreadScope<T extends ScopedProjectThread>(
  threads: ReadonlyArray<T>,
  enabled: boolean,
  scope: EnvironmentScope,
  projects: ReadonlyArray<ScopedProject>,
): ReadonlyArray<T> {
  return enabled ? filterByProjectScope(threads, scope, projects) : threads;
}

export function routeEnvironmentScope(input: {
  readonly enabled: boolean;
  readonly projectScope: unknown;
}): EnvironmentScope | null {
  if (!input.enabled || input.projectScope === null) return null;
  return resolveProjectScope(input.projectScope);
}

export function mobileScopeSearchEnvironmentIds(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: string;
  }>;
  readonly selectedEnvironmentId: EnvironmentId | null;
}): ReadonlyArray<EnvironmentId> {
  return input.environments
    .filter(
      (environment) =>
        environment.connectionState === "connected" &&
        (input.selectedEnvironmentId === null ||
          environment.environmentId === input.selectedEnvironmentId),
    )
    .map((environment) => environment.environmentId);
}
