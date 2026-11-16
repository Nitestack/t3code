import type { EnvironmentId, ProjectId, ProjectScope } from "@t3tools/contracts";

export type EnvironmentScope = ProjectScope;

export function isEnvironmentScope(value: unknown): value is EnvironmentScope {
  return value === "work" || value === "personal";
}

export function resolveActiveEnvironmentScope(value: unknown): EnvironmentScope {
  return isEnvironmentScope(value) ? value : "personal";
}

export interface ScopedProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly scope?: unknown;
}

export interface ScopedProjectThread {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function resolveProjectScope(scope: unknown): ProjectScope {
  return isEnvironmentScope(scope) ? scope : "personal";
}

export function filterProjectsByScope<T extends ScopedProject>(
  projects: ReadonlyArray<T>,
  scope: ProjectScope,
): ReadonlyArray<T> {
  return projects.filter((project) => resolveProjectScope(project.scope) === scope);
}

export function filterByProjectScope<T extends ScopedProjectThread>(
  values: ReadonlyArray<T>,
  scope: ProjectScope,
  projects: ReadonlyArray<ScopedProject>,
): ReadonlyArray<T> {
  const scopeByProjectKey = new Map(
    projects.map((project) => [
      `${project.environmentId}:${project.id}`,
      resolveProjectScope(project.scope),
    ]),
  );
  return values.filter(
    (value) => scopeByProjectKey.get(`${value.environmentId}:${value.projectId}`) === scope,
  );
}
