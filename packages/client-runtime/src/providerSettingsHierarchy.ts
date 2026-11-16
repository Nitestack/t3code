import type { ProjectScope } from "@t3tools/contracts";
import {
  aixMetadataFromInstanceId,
  resolvePickerHierarchy,
  type PickerProviderInstance,
} from "./providerPickerHierarchy.ts";

export type ProviderSettingsEntry = PickerProviderInstance;

export function providerSettingsEntryProfile<
  T extends Pick<PickerProviderInstance, "instanceId" | "driverKind"> & {
    readonly aixProfile?: string | undefined;
    readonly aixProfileLabel?: string | undefined;
  },
>(entry: T) {
  if (entry.aixProfile) {
    return { aixProfile: entry.aixProfile, aixProfileLabel: entry.aixProfileLabel };
  }
  const metadata = aixMetadataFromInstanceId(entry.instanceId, entry.driverKind);
  return metadata
    ? { ...metadata, aixProfileLabel: entry.aixProfileLabel ?? metadata.aixProfileLabel }
    : undefined;
}

export function resolveProviderSettingsHierarchy<T extends ProviderSettingsEntry>(input: {
  readonly entries: ReadonlyArray<T>;
  readonly scope: ProjectScope;
  readonly profileId?: string | undefined;
}) {
  const entries = input.entries.map((entry) => ({
    ...entry,
    ...providerSettingsEntryProfile(entry),
  }));
  // Settings must reach disabled instances, so every profile counts here.
  const hierarchy = resolvePickerHierarchy({
    entries: entries.map((entry) => ({ ...entry, enabled: true })),
    scope: "work",
  });
  const scope = hierarchy.profiles.length === 0 ? "personal" : input.scope;
  const profileId =
    scope === "work"
      ? hierarchy.profiles.some((profile) => profile.id === input.profileId)
        ? input.profileId
        : hierarchy.profileId
      : undefined;
  const visibleEntries = entries.filter((entry) =>
    scope === "work"
      ? entry.aixProfile !== undefined &&
        (profileId === undefined || entry.aixProfile === profileId)
      : entry.aixProfile === undefined,
  );
  return {
    scope,
    profiles: hierarchy.profiles,
    profileId,
    visibleEntries,
    hasAixProfiles: hierarchy.profiles.length > 0,
  };
}

export function providerSettingsRowLabels(input: {
  readonly driverLabel: string;
  readonly displayName?: string | undefined;
  /** aix display names repeat the profile, which the profile selector already shows. */
  readonly isAix?: boolean | undefined;
  readonly version?: string | null | undefined;
  readonly status: string;
  readonly accountSource?: string | undefined;
}) {
  const accountSource = input.accountSource?.trim();
  return {
    title: (input.isAix ? undefined : input.displayName?.trim()) || input.driverLabel,
    version: input.version ?? null,
    detail: [input.status, accountSource].filter(Boolean).join(" · "),
  };
}
