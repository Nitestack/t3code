import { useAtomValue } from "@effect/atom-react";
import Constants from "expo-constants";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { Platform } from "react-native";

import {
  resolveActiveEnvironmentScope,
  type EnvironmentScope,
} from "@t3tools/client-runtime/environment";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  filterMobileProjectScope,
  filterMobileThreadScope,
  isAndroidForkEnvironmentScopeEnabled,
} from "./mobile-environment-scope";

export function useMobileEnvironmentScope() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const enabled = isAndroidForkEnvironmentScopeEnabled({
    platformOS: Platform.OS,
    appVariant: Constants.expoConfig?.extra?.appVariant,
  });
  const activeScope = resolveActiveEnvironmentScope(preferences.activeEnvironmentScope);

  const setActiveScope = useCallback(
    (scope: EnvironmentScope) => {
      if (enabled) void savePreferences({ activeEnvironmentScope: scope });
    },
    [enabled, savePreferences],
  );
  return {
    enabled,
    activeScope,
    setActiveScope,
    filter: useCallback(
      <
        T extends {
          readonly environmentId: import("@t3tools/contracts").EnvironmentId;
          readonly id: import("@t3tools/contracts").ProjectId;
          readonly scope?: EnvironmentScope;
        },
      >(
        values: ReadonlyArray<T>,
      ) => filterMobileProjectScope(values, enabled, activeScope),
      [activeScope, enabled],
    ),
    filterThreads: useCallback(
      <
        T extends {
          readonly environmentId: import("@t3tools/contracts").EnvironmentId;
          readonly projectId: import("@t3tools/contracts").ProjectId;
        },
      >(
        values: ReadonlyArray<T>,
        projects: ReadonlyArray<{
          readonly environmentId: import("@t3tools/contracts").EnvironmentId;
          readonly id: import("@t3tools/contracts").ProjectId;
          readonly scope?: EnvironmentScope;
        }>,
      ) => filterMobileThreadScope(values, enabled, activeScope, projects),
      [activeScope, enabled],
    ),
  } as const;
}
