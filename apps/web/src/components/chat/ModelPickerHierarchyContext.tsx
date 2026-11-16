import type {
  AixProviderProfile,
  PickerScope,
} from "@t3tools/client-runtime/provider-picker-hierarchy";
import { createContext, useContext } from "react";
import type { ProviderInstanceEntry } from "../../providerInstances";

export type ModelPickerHierarchy = {
  readonly profiles: ReadonlyArray<AixProviderProfile<ProviderInstanceEntry>>;
  readonly scope: PickerScope;
  readonly profileId: string | undefined;
  readonly onScopeChange: (scope: PickerScope) => void;
  readonly onProfileChange: (profileId: string) => void;
};

export const ModelPickerHierarchyContext = createContext<ModelPickerHierarchy | null>(null);
export const useModelPickerHierarchy = () => useContext(ModelPickerHierarchyContext);
