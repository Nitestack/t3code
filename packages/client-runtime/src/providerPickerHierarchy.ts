import type { ProjectScope, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

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
