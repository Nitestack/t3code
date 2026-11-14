import type { MenuAction } from "@react-native-menu/menu";
import { useMemo } from "react";
import { View } from "react-native";

import { getEnvironmentScope, type EnvironmentScope } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useMobileEnvironmentScope } from "./useMobileEnvironmentScope";

interface ScopeEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function EnvironmentScopeSwitcher(props: {
  readonly environments: ReadonlyArray<ScopeEnvironment>;
  readonly onScopeChange?: () => void;
}) {
  const { enabled, activeScope, assignments, setActiveScope, setEnvironmentScope } =
    useMobileEnvironmentScope();
  const actionsById = useMemo(() => {
    const byId = new Map<
      string,
      { readonly environmentId: EnvironmentId; readonly scope: EnvironmentScope }
    >();
    const actions: MenuAction[] = props.environments.map((environment, index) => {
      const currentScope = getEnvironmentScope(assignments, environment.environmentId);
      const workId = `environment:${index}:work`;
      const personalId = `environment:${index}:personal`;
      byId.set(workId, { environmentId: environment.environmentId, scope: "work" });
      byId.set(personalId, { environmentId: environment.environmentId, scope: "personal" });
      return {
        id: `environment:${index}`,
        title: environment.label,
        subactions: [
          { id: workId, title: "Work", attributes: { disabled: currentScope === "work" } },
          {
            id: personalId,
            title: "Personal",
            attributes: { disabled: currentScope === "personal" },
          },
        ],
      };
    });
    return { actions, byId };
  }, [assignments, props.environments]);

  if (!enabled) return null;

  return (
    <View className="flex-row items-center gap-2 px-3 py-2">
      <SegmentedControl
        className="min-w-0 flex-1"
        role="button"
        selected={activeScope}
        options={[
          { value: "work", label: "Work" },
          { value: "personal", label: "Personal" },
        ]}
        onSelect={(scope) => {
          if (scope === activeScope) return;
          setActiveScope(scope);
          props.onScopeChange?.();
        }}
      />
      {props.environments.length > 0 ? (
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel="Classify environments"
          title="Classify environments"
          actions={actionsById.actions}
          onPressAction={({ nativeEvent }) => {
            const selection = actionsById.byId.get(nativeEvent.event);
            if (selection) setEnvironmentScope(selection.environmentId, selection.scope);
          }}
        >
          <ControlPill icon="ellipsis" accessibilityLabel="Classify environments" />
        </Menu>
      ) : null}
    </View>
  );
}
