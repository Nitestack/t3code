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
