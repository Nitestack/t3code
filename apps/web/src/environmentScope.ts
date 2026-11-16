import {
  type EnvironmentScope,
  filterByProjectScope,
  filterProjectsByScope,
} from "@t3tools/client-runtime/environment";
import { updateClientSettings, useClientSettings } from "./hooks/useSettings";

export function useClientEnvironmentScope() {
  const activeScope = useClientSettings((settings) => settings.activeEnvironmentScope);
  return { activeScope };
}

export function setActiveEnvironmentScope(scope: EnvironmentScope): Promise<void> {
  return updateClientSettings({ activeEnvironmentScope: scope });
}

export const filterProjectsForScope = filterProjectsByScope;
export const filterThreadsForScope = filterByProjectScope;
