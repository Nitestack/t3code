import {
  filterByEnvironmentScope,
  getEnvironmentScope,
  type EnvironmentScope,
  type EnvironmentScopeAssignments,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";

export function isAndroidForkEnvironmentScopeEnabled(input: {
  readonly platformOS: string;
  readonly appVariant: unknown;
}): boolean {
  return input.platformOS === "android" && input.appVariant === "android-fork";
}

export function filterMobileEnvironmentScope<T extends { readonly environmentId: EnvironmentId }>(
  values: ReadonlyArray<T>,
  enabled: boolean,
  scope: EnvironmentScope,
  assignments: EnvironmentScopeAssignments,
): ReadonlyArray<T> {
  return enabled ? filterByEnvironmentScope(values, scope, assignments) : values;
}

export function routeEnvironmentScope(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly assignments: EnvironmentScopeAssignments;
}): EnvironmentScope | null {
  return input.enabled && input.environmentId !== null
    ? getEnvironmentScope(input.assignments, input.environmentId)
    : null;
}

export function mobileScopeSearchEnvironmentIds(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: string;
  }>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly enabled: boolean;
  readonly scope: EnvironmentScope;
  readonly assignments: EnvironmentScopeAssignments;
}): ReadonlyArray<EnvironmentId> {
  return filterMobileEnvironmentScope(
    input.environments,
    input.enabled,
    input.scope,
    input.assignments,
  )
    .filter(
      (environment) =>
        environment.connectionState === "connected" &&
        (input.selectedEnvironmentId === null ||
          environment.environmentId === input.selectedEnvironmentId),
    )
    .map((environment) => environment.environmentId);
}
