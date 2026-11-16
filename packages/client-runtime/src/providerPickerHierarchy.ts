import {
  ProviderDriverKind,
  ProviderInstanceId,
  DEFAULT_MODEL_BY_PROVIDER,
  type ProjectScope,
  type ModelSelection,
} from "@t3tools/contracts";
import { resolveProjectScope } from "./environment/scope.ts";

export type PickerProviderInstance = {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly enabled?: boolean | undefined;
  readonly aixProfile?: string | undefined;
  readonly aixProfileLabel?: string | undefined;
};

export type PickerFilterState =
  | { readonly tag: "all" }
  | { readonly tag: "favorites" }
  | { readonly tag: "provider"; readonly providerKey: string }
  | { readonly tag: "aix-profile"; readonly profileId: string }
  | { readonly tag: "aix-harness"; readonly profileId: string; readonly providerKey: string };

export function resolveModelPickerProjectScope(
  projectScope: unknown,
  projectScopeSupported: boolean,
): ProjectScope {
  return projectScopeSupported ? resolveProjectScope(projectScope) : "personal";
}

export const pickerFilterProfileId = (filter: PickerFilterState | null): string | undefined =>
  filter?.tag === "aix-profile" || filter?.tag === "aix-harness" ? filter.profileId : undefined;
export const pickerFilterProviderKey = (filter: PickerFilterState | null): string | undefined =>
  filter?.tag === "provider"
    ? filter.providerKey
    : filter?.tag === "aix-harness"
      ? filter.providerKey
      : undefined;
export const pickerFilterIsFavorites = (filter: PickerFilterState | null): boolean =>
  filter?.tag === "favorites";
export type AixProviderProfile<T extends PickerProviderInstance> = {
  readonly id: string;
  readonly label: string;
  readonly entries: ReadonlyArray<T>;
};

export function pickerInstancesFromModelGroups<
  T extends {
    readonly providerKey: string;
    readonly models: ReadonlyArray<{
      readonly providerDriver?: string | undefined;
      readonly aixProfile?: string | undefined;
      readonly aixProfileLabel?: string | undefined;
    }>;
  },
>(groups: ReadonlyArray<T>) {
  return groups.map((group) => {
    const model = group.models[0];
    return {
      providerKey: group.providerKey,
      instanceId: ProviderInstanceId.make(group.providerKey),
      driverKind: ProviderDriverKind.make(model?.providerDriver ?? group.providerKey),
      enabled: true,
      ...(model?.aixProfile ? { aixProfile: model.aixProfile } : {}),
      ...(model?.aixProfileLabel ? { aixProfileLabel: model.aixProfileLabel } : {}),
    };
  });
}

export function aixMetadataFromInstanceId(instanceId: string, driverKind: ProviderDriverKind) {
  const prefix = `aix-${driverKind}-`;
  if (!instanceId.startsWith(prefix)) return undefined;
  const profileId = instanceId.slice(prefix.length);
  return profileId ? { aixProfile: profileId, aixProfileLabel: profileId } : undefined;
}

export function groupAixProviderProfiles<T extends PickerProviderInstance>(
  entries: ReadonlyArray<T>,
): ReadonlyArray<AixProviderProfile<T>> {
  const profiles = new Map<string, { label: string; entries: T[] }>();
  for (const entry of entries) {
    if (!entry.enabled || !entry.aixProfile) continue;
    const profile = profiles.get(entry.aixProfile);
    if (profile) profile.entries.push(entry);
    else
      profiles.set(entry.aixProfile, {
        label: entry.aixProfileLabel ?? entry.aixProfile,
        entries: [entry],
      });
  }
  return [...profiles].map(([id, profile]) => ({ id, ...profile }));
}

export function resolveAixProfileId<T extends PickerProviderInstance>(input: {
  readonly profiles: ReadonlyArray<AixProviderProfile<T>>;
  readonly rememberedProfileId?: string | undefined;
  readonly selectedModelProfileId?: string | undefined;
}): string | undefined {
  const exists = (profileId: string | undefined) =>
    profileId !== undefined && input.profiles.some((profile) => profile.id === profileId);
  if (exists(input.rememberedProfileId)) return input.rememberedProfileId;
  if (exists(input.selectedModelProfileId)) return input.selectedModelProfileId;
  return input.profiles[0]?.id;
}

export function aixProfileLabels(
  entries: ReadonlyArray<PickerProviderInstance>,
): ReadonlyMap<string, string> {
  return new Map(groupAixProviderProfiles(entries).map(({ id, label }) => [id, label]));
}

export function aixProfileLabel(profileId: string, labels: ReadonlyMap<string, string>): string {
  // Older servers omit profile labels, so keep the stable profile id visible.
  return labels.get(profileId) ?? profileId;
}

export function providerInstancesForProjectScope<T extends PickerProviderInstance>(input: {
  readonly entries: ReadonlyArray<T>;
  readonly scope: ProjectScope;
  readonly aixProfile?: string | undefined;
  readonly selectedInstanceId?: ProviderInstanceId | undefined;
}): ReadonlyArray<T> {
  const inScope = (entry: T) =>
    input.scope === "work"
      ? entry.enabled === true && entry.aixProfile !== undefined
      : entry.aixProfile === undefined;
  const candidates = input.entries.filter(
    (entry) =>
      inScope(entry) &&
      (input.scope !== "work" ||
        input.aixProfile === undefined ||
        entry.aixProfile === input.aixProfile),
  );
  const selected =
    input.selectedInstanceId === undefined
      ? undefined
      : input.entries.find((entry) => entry.instanceId === input.selectedInstanceId);
  if (selected && !inScope(selected)) {
    candidates.push(selected);
  }
  if (input.scope === "personal") return candidates;
  const byDriver = new Map<ProviderDriverKind, T>();
  for (const entry of candidates) {
    if (inScope(entry) && !byDriver.has(entry.driverKind)) byDriver.set(entry.driverKind, entry);
  }
  const selectedOutOfScope = selected && !inScope(selected) ? [selected] : [];
  return [...byDriver.values(), ...selectedOutOfScope];
}

export function resolvePickerHierarchy<T extends PickerProviderInstance>(input: {
  readonly entries: ReadonlyArray<T>;
  readonly scope: ProjectScope;
  readonly rememberedProfileId?: string | undefined;
  readonly selectedModelProfileId?: string | undefined;
  readonly selectedInstanceId?: ProviderInstanceId | undefined;
}) {
  const profiles = groupAixProviderProfiles(input.entries);
  const profileId =
    input.scope === "work"
      ? resolveAixProfileId({
          profiles,
          rememberedProfileId: input.rememberedProfileId,
          selectedModelProfileId: input.selectedModelProfileId,
        })
      : undefined;
  const visibleEntries = providerInstancesForProjectScope({
    entries: input.entries,
    scope: input.scope,
    ...(profileId ? { aixProfile: profileId } : {}),
    ...(input.selectedInstanceId ? { selectedInstanceId: input.selectedInstanceId } : {}),
  });
  return { profiles, profileId, visibleEntries };
}

type DraftDefaultProvider = {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: string;
  readonly auth?: { readonly status?: string | undefined } | undefined;
  readonly availability?: string | undefined;
  readonly aixProfile?: string | undefined;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean | undefined;
  }>;
};

export function resolveDraftModelSelectionForScope(input: {
  readonly scope: ProjectScope;
  readonly explicitSelection?: ModelSelection | null | undefined;
  readonly stickySelection?: ModelSelection | null | undefined;
  /** The project's configured model, before scope and readiness are applied. */
  readonly normalDefault?: ModelSelection | null | undefined;
  /** Provider-order default; unlike a configured one it ranks below the last-used selection. */
  readonly orderedDefault?: ModelSelection | null | undefined;
  readonly providers: ReadonlyArray<DraftDefaultProvider>;
}): ModelSelection | null {
  if (input.explicitSelection) return input.explicitSelection;
  const providers = input.providers.map((provider) => ({
    ...provider,
    aixProfile:
      provider.aixProfile ??
      aixMetadataFromInstanceId(provider.instanceId, provider.driver)?.aixProfile,
  }));
  const inScope = (provider: DraftDefaultProvider) =>
    input.scope === "work"
      ? provider.aixProfile !== undefined || provider.instanceId.startsWith("aix-")
      : provider.aixProfile === undefined && !provider.instanceId.startsWith("aix-");
  const ready = (provider: DraftDefaultProvider) =>
    provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    (provider.status === "ready" ||
      (provider.status !== "error" &&
        (provider.status === "authenticated" || provider.auth?.status === "authenticated")));
  const selectable = (selection: ModelSelection | null | undefined) => {
    if (!selection) return null;
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    return provider && inScope(provider) && ready(provider) ? selection : null;
  };
  const configured = selectable(input.normalDefault);
  if (configured) return configured;
  const sticky = selectable(input.stickySelection);
  if (sticky) return sticky;
  const ordered = selectable(input.orderedDefault);
  if (ordered) return ordered;
  const firstReady = providers.find((provider) => inScope(provider) && ready(provider));
  return firstReady ? defaultSelectionForProvider(firstReady) : null;
}

function defaultSelectionForProvider(provider: DraftDefaultProvider): ModelSelection | null {
  const model = provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0];
  const modelSlug = model?.slug ?? DEFAULT_MODEL_BY_PROVIDER[provider.driver];
  return modelSlug ? { instanceId: provider.instanceId, model: modelSlug } : null;
}

export function isPickerModelVisibleForProjectScope(input: {
  readonly scope: ProjectScope;
  readonly modelProfileId?: string | undefined;
  readonly selectedProfileId?: string | undefined;
  readonly isSelected: boolean;
}): boolean {
  if (input.isSelected) return true;
  return input.scope === "work"
    ? input.modelProfileId !== undefined && input.modelProfileId === input.selectedProfileId
    : input.modelProfileId === undefined;
}
