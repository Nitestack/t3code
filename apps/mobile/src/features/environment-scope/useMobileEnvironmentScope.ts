import { useAtomSet, useAtomValue } from "@effect/atom-react";
import Constants from "expo-constants";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { Platform } from "react-native";

import {
  assignEnvironmentScope,
  resolveActiveEnvironmentScope,
  type EnvironmentScope,
  type EnvironmentScopeAssignments,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  filterMobileEnvironmentScope,
  isAndroidForkEnvironmentScopeEnabled,
} from "./mobile-environment-scope";

const EMPTY_ASSIGNMENTS: EnvironmentScopeAssignments = {};

export function useMobileEnvironmentScope() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const enabled = isAndroidForkEnvironmentScopeEnabled({
    platformOS: Platform.OS,
    appVariant: Constants.expoConfig?.extra?.appVariant,
  });
  const activeScope = resolveActiveEnvironmentScope(preferences.activeEnvironmentScope);
  const assignments =
    (preferences.environmentScopeAssignments as EnvironmentScopeAssignments | undefined) ??
    EMPTY_ASSIGNMENTS;

  const setActiveScope = useCallback(
    (scope: EnvironmentScope) => {
      if (enabled) savePreferences({ activeEnvironmentScope: scope });
    },
    [enabled, savePreferences],
  );
  const setEnvironmentScope = useCallback(
    (environmentId: EnvironmentId, scope: EnvironmentScope) => {
      if (!enabled) return;
      savePreferences({
        transform: (current) => ({
          environmentScopeAssignments: assignEnvironmentScope(
            current.environmentScopeAssignments ?? {},
            environmentId,
            scope,
          ),
        }),
      });
    },
    [enabled, savePreferences],
  );

  return {
    enabled,
    activeScope,
    assignments,
    setActiveScope,
    setEnvironmentScope,
    filter: useCallback(
      <T extends { readonly environmentId: EnvironmentId }>(values: ReadonlyArray<T>) =>
        filterMobileEnvironmentScope(values, enabled, activeScope, assignments),
      [activeScope, assignments, enabled],
    ),
  } as const;
}
