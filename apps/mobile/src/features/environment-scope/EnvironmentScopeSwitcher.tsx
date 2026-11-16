import { View } from "react-native";

import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useMobileEnvironmentScope } from "./useMobileEnvironmentScope";

export function EnvironmentScopeSwitcher(props: { readonly onScopeChange?: () => void }) {
  const { enabled, activeScope, setActiveScope } = useMobileEnvironmentScope();

  if (!enabled) return null;

  return (
    <View className="flex-row items-center gap-2 px-3 py-2">
      <SegmentedControl
        className="min-w-0 flex-1"
        role="button"
        selected={activeScope}
        options={[
          { value: "personal", label: "Personal" },
          { value: "work", label: "Work" },
        ]}
        onSelect={(scope) => {
          if (scope === activeScope) return;
          setActiveScope(scope);
          props.onScopeChange?.();
        }}
      />
    </View>
  );
}
