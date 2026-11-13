import type { EnvironmentId } from "@t3tools/contracts";
import type { ClientEnvironmentScope } from "@t3tools/contracts/settings";

export type EnvironmentScope = ClientEnvironmentScope;
export type EnvironmentScopeAssignments = Readonly<Record<string, EnvironmentScope>>;

export function isEnvironmentScope(value: unknown): value is EnvironmentScope {
  return value === "work" || value === "personal";
}

export function resolveActiveEnvironmentScope(value: unknown): EnvironmentScope {
  return isEnvironmentScope(value) ? value : "personal";
}

export function normalizeEnvironmentScopeAssignments(value: unknown): EnvironmentScopeAssignments {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, EnvironmentScope] =>
      isEnvironmentScope(entry[1]),
    ),
  );
}

export function getEnvironmentScope(
  assignments: EnvironmentScopeAssignments,
  environmentId: EnvironmentId,
): EnvironmentScope {
  return Object.hasOwn(assignments, environmentId) && assignments[environmentId] === "work"
    ? "work"
    : "personal";
}

export function assignEnvironmentScope(
  assignments: EnvironmentScopeAssignments,
  environmentId: EnvironmentId,
  scope: EnvironmentScope,
): EnvironmentScopeAssignments {
  return { ...assignments, [environmentId]: scope };
}

export function filterByEnvironmentScope<T extends { readonly environmentId: EnvironmentId }>(
  values: ReadonlyArray<T>,
  scope: EnvironmentScope,
  assignments: EnvironmentScopeAssignments,
): ReadonlyArray<T> {
  return values.filter((value) => getEnvironmentScope(assignments, value.environmentId) === scope);
}
