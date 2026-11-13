import {
  getEnvironmentScope,
  type EnvironmentScope,
  type EnvironmentScopeAssignments,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { getClientSettings, updateClientSettings, useClientSettings } from "./hooks/useSettings";

export function useClientEnvironmentScope() {
  const activeScope = useClientSettings((settings) => settings.activeEnvironmentScope);
  const assignments = useClientSettings((settings) => settings.environmentScopeAssignments);
  return { activeScope, assignments };
}

export function filterEnvironmentIdsByScope(
  environmentIds: ReadonlyArray<EnvironmentId>,
  scope: EnvironmentScope,
  assignments: EnvironmentScopeAssignments,
): EnvironmentId[] {
  return environmentIds.filter(
    (environmentId) => getEnvironmentScope(assignments, environmentId) === scope,
  );
}

export function setActiveEnvironmentScope(scope: EnvironmentScope): Promise<void> {
  return updateClientSettings({ activeEnvironmentScope: scope });
}

export function setEnvironmentScopeAssignment(
  environmentId: EnvironmentId,
  scope: EnvironmentScope,
): Promise<void> {
  const assignments = getClientSettings().environmentScopeAssignments;
  return updateClientSettings({
    environmentScopeAssignments: { ...assignments, [environmentId]: scope },
  });
}
