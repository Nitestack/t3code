import type { UsageScope } from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export function UsageScopeControl({
  groups,
  scope,
  compact = false,
  onChange,
}: {
  readonly groups: ReadonlySet<UsageScope>;
  readonly scope: UsageScope;
  readonly compact?: boolean;
  readonly onChange: (scope: UsageScope) => void;
}) {
  if (groups.size < 2) return null;
  if (compact) {
    return (
      <div className="w-24">
        <Select
          value={scope}
          onValueChange={(value) => {
            if (value === "personal" || value === "work") onChange(value);
          }}
        >
          <SelectTrigger aria-label="Usage scope" size="compact" variant="ghost">
            <SelectValue>{scope === "work" ? "Work" : "Personal"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="personal">Personal</SelectItem>
            <SelectItem value="work">Work</SelectItem>
          </SelectPopup>
        </Select>
      </div>
    );
  }
  return (
    <ToggleGroup
      aria-label="Usage scope"
      variant="segmented"
      value={[scope]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "personal" || value === "work") onChange(value);
      }}
    >
      <Toggle value="personal">Personal</Toggle>
      <Toggle value="work">Work</Toggle>
    </ToggleGroup>
  );
}
