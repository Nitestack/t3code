import { ChevronUpIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { composerFloatingLayerProps } from "./composerEventScope";
import { useModelPickerHierarchy } from "./ModelPickerHierarchyContext";

export function ModelPickerHierarchyFooterControls() {
  const hierarchy = useModelPickerHierarchy();
  if (!hierarchy || hierarchy.scope !== "work") return null;
  const selectedProfile = hierarchy.profiles.find((profile) => profile.id === hierarchy.profileId);
  return (
    <div className="flex min-w-0 items-center gap-1" data-model-picker-hierarchy-controls>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost-muted"
              size="xs"
              aria-label={`Work profile: ${selectedProfile?.label ?? "Choose profile"}`}
            />
          }
        >
          <span className="max-w-28 truncate">{selectedProfile?.label ?? "Choose profile"}</span>
          <ChevronUpIcon aria-hidden="true" className="size-3" />
        </MenuTrigger>
        <MenuPopup side="top" align="start" {...composerFloatingLayerProps}>
          <MenuRadioGroup
            aria-label="Work profile"
            value={hierarchy.profileId ?? ""}
            onValueChange={(value: string) => hierarchy.onProfileChange(value)}
          >
            {hierarchy.profiles.map((profile) => (
              <MenuRadioItem key={profile.id} value={profile.id} closeOnClick>
                {profile.label} <MenuRadioItemIndicator />
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}
