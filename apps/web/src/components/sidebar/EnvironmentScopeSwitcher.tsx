import { useClientEnvironmentScope, setActiveEnvironmentScope } from "../../environmentScope";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export function EnvironmentScopeSwitcher() {
  const { activeScope } = useClientEnvironmentScope();

  return (
    <div className="flex min-w-0 items-center gap-1">
      <ToggleGroup
        aria-label="Project scope"
        className="min-w-0 flex-1 *:flex-1"
        value={[activeScope]}
        onValueChange={(value) => {
          const nextScope = value[0];
          if (nextScope === "work" || nextScope === "personal") {
            void setActiveEnvironmentScope(nextScope);
          }
        }}
      >
        <Toggle value="personal">Personal</Toggle>
        <Toggle value="work">Work</Toggle>
      </ToggleGroup>
    </div>
  );
}
