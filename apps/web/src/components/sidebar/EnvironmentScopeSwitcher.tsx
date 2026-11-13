import { Settings2Icon } from "lucide-react";

import { getEnvironmentScope } from "@t3tools/client-runtime/environment";
import { useEnvironmentIdentities } from "../../state/environments";
import {
  useClientEnvironmentScope,
  setActiveEnvironmentScope,
  setEnvironmentScopeAssignment,
} from "../../environmentScope";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export function EnvironmentScopeSwitcher() {
  const { activeScope, assignments } = useClientEnvironmentScope();
  const environments = useEnvironmentIdentities();

  return (
    <div className="flex min-w-0 items-center gap-1">
      <ToggleGroup
        aria-label="Environment scope"
        className="min-w-0 flex-1"
        value={[activeScope]}
        onValueChange={(value) => {
          const nextScope = value[0];
          if (nextScope === "work" || nextScope === "personal") {
            void setActiveEnvironmentScope(nextScope);
          }
        }}
      >
        <Toggle value="work">Work</Toggle>
        <Toggle value="personal">Personal</Toggle>
      </ToggleGroup>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button aria-label="Classify environments" size="icon-xs" variant="ghost-muted" />
          }
        >
          <Settings2Icon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-[min(20rem,calc(100vw-2rem))]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Work environments</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {environments.map((environment) => (
              <DropdownMenuCheckboxItem
                key={environment.environmentId}
                checked={getEnvironmentScope(assignments, environment.environmentId) === "work"}
                closeOnClick={false}
                onCheckedChange={(checked) =>
                  void setEnvironmentScopeAssignment(
                    environment.environmentId,
                    checked ? "work" : "personal",
                  )
                }
              >
                {environment.label}
              </DropdownMenuCheckboxItem>
            ))}
            {environments.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                No environments available
              </div>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
