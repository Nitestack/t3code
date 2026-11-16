import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  aixMetadataFromInstanceId,
  groupAixProviderProfiles,
  pickerFilterIsFavorites,
  pickerFilterIsSubscriptions,
  pickerFilterProfileId,
  pickerFilterProviderKey,
  pickerFilterStateForSelection,
  pickerSelectionTarget,
  providerInstancesForPickerLevel,
} from "./providerPickerHierarchy.ts";

const entry = (
  instanceId: string,
  driver: string,
  profile?: string,
  label?: string,
  enabled = true,
) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driverKind: ProviderDriverKind.make(driver),
  enabled,
  ...(profile ? { aixProfile: profile, aixProfileLabel: label } : {}),
});

describe("provider picker hierarchy", () => {
  const entries = [
    entry("codex", "codex"),
    entry("aix-codex-ac", "codex", "ac", "adCare"),
    entry("aix-opencode-ac", "opencode", "ac", "adCare"),
    entry("aix-codex-personal", "codex", "personal", "Persönlich"),
    entry("aix-codex-ac-disabled", "codex", "ac", "adCare", false),
  ];

  it("groups only picker-visible profiles with display labels", () => {
    expect(groupAixProviderProfiles(entries)).toEqual([
      { id: "ac", label: "adCare", entries: [entries[1], entries[2]] },
      { id: "personal", label: "Persönlich", entries: [entries[3]] },
    ]);
  });

  it("deduplicates harnesses within a profile and keeps the first enabled entry", () => {
    const disabledFirst = entry("aix-codex-ac-disabled-first", "codex", "ac", "adCare", false);
    const enabledSecond = entry("aix-codex-ac-second", "codex", "ac", "adCare");
    expect(
      providerInstancesForPickerLevel({
        entries: [disabledFirst, ...entries, enabledSecond],
        scope: "aix",
        aixProfile: "ac",
      }),
    ).toEqual([entries[1], entries[2]]);
  });

  it("keeps subscriptions separate and maps a profile plus harness to its exact instance", () => {
    expect(
      providerInstancesForPickerLevel({ entries, scope: "subscriptions" }).map(
        (item) => item.instanceId,
      ),
    ).toEqual(["codex"]);
    expect(
      pickerSelectionTarget({
        entries,
        scope: "aix",
        profileId: "ac",
        preferredDriver: ProviderDriverKind.make("opencode"),
      })?.instanceId,
    ).toBe("aix-opencode-ac");
    expect(
      pickerFilterStateForSelection({ scope: "aix", profileId: "ac", providerKey: "codex" }),
    ).toEqual({ tag: "aix-harness", profileId: "ac", providerKey: "codex" });
    expect(groupAixProviderProfiles([entries[0]!])).toEqual([]);
  });

  it("reads typed mobile filters without encoding profile or harness strings", () => {
    const profileFilter = { tag: "aix-profile", profileId: "ac" } as const;
    const harnessFilter = {
      tag: "aix-harness",
      profileId: "ac",
      providerKey: "codex",
    } as const;
    expect(pickerFilterProfileId(profileFilter)).toBe("ac");
    expect(pickerFilterProfileId(harnessFilter)).toBe("ac");
    expect(pickerFilterProviderKey(harnessFilter)).toBe("codex");
    expect(pickerFilterProviderKey({ tag: "provider", providerKey: "codex" })).toBe("codex");
    expect(pickerFilterIsFavorites({ tag: "favorites" })).toBe(true);
    expect(pickerFilterIsSubscriptions({ tag: "subscriptions" })).toBe(true);
  });

  it("classifies older snapshots by the aix instance id prefix", () => {
    expect(
      aixMetadataFromInstanceId(
        "aix-claudeAgent-engineering",
        ProviderDriverKind.make("claudeAgent"),
      ),
    ).toEqual({ aixProfile: "engineering", aixProfileLabel: "engineering" });
    expect(aixMetadataFromInstanceId("codex", ProviderDriverKind.make("codex"))).toBeUndefined();
  });
});
