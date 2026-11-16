import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

export type PickerProviderInstance = {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly enabled?: boolean | undefined;
  readonly aixProfile?: string | undefined;
  readonly aixProfileLabel?: string | undefined;
};

export type PickerScope = "subscriptions" | "aix";
export type PickerFilterState =
  | { readonly tag: "all" }
  | { readonly tag: "favorites" }
  | { readonly tag: "subscriptions" }
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
export const pickerFilterIsSubscriptions = (filter: PickerFilterState | null): boolean =>
  filter?.tag === "subscriptions";

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

export function providerInstancesForPickerLevel<T extends PickerProviderInstance>(input: {
  readonly entries: ReadonlyArray<T>;
  readonly scope: PickerScope;
  readonly aixProfile?: string | undefined;
}): ReadonlyArray<T> {
  const candidates = input.entries.filter((entry) =>
    input.scope === "aix"
      ? entry.enabled === true &&
        entry.aixProfile !== undefined &&
        entry.aixProfile === input.aixProfile
      : entry.aixProfile === undefined,
  );
  if (input.scope !== "aix") return candidates;
  const byDriver = new Map<ProviderDriverKind, T>();
  for (const entry of candidates)
    if (!byDriver.has(entry.driverKind)) byDriver.set(entry.driverKind, entry);
  return [...byDriver.values()];
}

export function pickerFilterStateForSelection(input: {
  readonly scope: PickerScope;
  readonly profileId?: string | undefined;
  readonly providerKey?: string | undefined;
}): PickerFilterState {
  if (input.scope === "subscriptions")
    return input.providerKey
      ? { tag: "provider", providerKey: input.providerKey }
      : { tag: "subscriptions" };
  if (input.profileId === undefined) return { tag: "all" };
  return input.providerKey
    ? { tag: "aix-harness", profileId: input.profileId, providerKey: input.providerKey }
    : { tag: "aix-profile", profileId: input.profileId };
}

export function pickerSelectionTarget<T extends PickerProviderInstance>(input: {
  readonly entries: ReadonlyArray<T>;
  readonly scope: PickerScope;
  readonly profileId?: string | undefined;
  readonly preferredDriver?: ProviderDriverKind | undefined;
}): T | undefined {
  const candidates = providerInstancesForPickerLevel({
    entries: input.entries,
    scope: input.scope,
    ...(input.profileId === undefined ? {} : { aixProfile: input.profileId }),
  });
  return candidates.find((entry) => entry.driverKind === input.preferredDriver) ?? candidates[0];
}
