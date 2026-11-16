import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

export type PickerProviderInstance = {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly aixProfile?: string | undefined;
  readonly aixProfileLabel?: string | undefined;
};

export type AixProviderProfile<T extends PickerProviderInstance> = {
  readonly id: string;
  readonly label: string;
  readonly entries: ReadonlyArray<T>;
};

export function groupAixProviderProfiles<T extends PickerProviderInstance>(
  entries: ReadonlyArray<T>,
): ReadonlyArray<AixProviderProfile<T>> {
  const profiles = new Map<string, { label: string; entries: T[] }>();
  for (const entry of entries) {
    if (!entry.aixProfile) continue;
    const profile = profiles.get(entry.aixProfile);
    if (profile) {
      profile.entries.push(entry);
    } else {
      profiles.set(entry.aixProfile, {
        label: entry.aixProfileLabel ?? entry.aixProfile,
        entries: [entry],
      });
    }
  }
  return [...profiles].map(([id, profile]) => ({ id, ...profile }));
}

export function providerInstancesForPickerLevel<T extends PickerProviderInstance>(input: {
  readonly entries: ReadonlyArray<T>;
  readonly scope: "subscriptions" | "aix";
  readonly aixProfile?: string | undefined;
}): ReadonlyArray<T> {
  return input.entries.filter((entry) =>
    input.scope === "aix"
      ? entry.aixProfile !== undefined && entry.aixProfile === input.aixProfile
      : entry.aixProfile === undefined,
  );
}

export function providerInstanceForPickerSelection<T extends PickerProviderInstance>(input: {
  readonly entries: ReadonlyArray<T>;
  readonly scope: "subscriptions" | "aix";
  readonly aixProfile?: string | undefined;
  readonly preferredDriver?: ProviderDriverKind | undefined;
}): T | undefined {
  const candidates = providerInstancesForPickerLevel(input);
  return candidates.find((entry) => entry.driverKind === input.preferredDriver) ?? candidates[0];
}
