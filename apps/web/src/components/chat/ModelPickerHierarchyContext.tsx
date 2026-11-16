import type { AixProviderProfile } from "@t3tools/client-runtime/provider-picker-hierarchy";
import type { ProjectScope } from "@t3tools/contracts";
import { createContext, useContext } from "react";
import type { ProviderInstanceEntry } from "../../providerInstances";

export type ModelPickerHierarchy = {
  readonly profiles: ReadonlyArray<AixProviderProfile<ProviderInstanceEntry>>;
  readonly scope: ProjectScope;
  readonly profileId: string | undefined;
  readonly onScopeChange: (scope: ProjectScope) => void;
  readonly onProfileChange: (profileId: string) => void;
};

export const ModelPickerHierarchyContext = createContext<ModelPickerHierarchy | null>(null);
export const useModelPickerHierarchy = () => useContext(ModelPickerHierarchyContext);
