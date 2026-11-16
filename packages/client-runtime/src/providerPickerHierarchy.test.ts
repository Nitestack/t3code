import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  aixMetadataFromInstanceId,
  aixProfileLabel,
  aixProfileLabels,
  groupAixProviderProfiles,
  isPickerModelVisibleForProjectScope,
  pickerFilterIsFavorites,
  pickerFilterProfileId,
  pickerFilterProviderKey,
  providerInstancesForProjectScope,
  resolveScopedDraftModelSelection,
  resolveAixProfileId,
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

  it("does not infer a profile for subscription instances", () => {
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

  it("filters instances by project scope and keeps the selected instance visible", () => {
    expect(
      providerInstancesForProjectScope({ entries, scope: "personal" }).map(
        (item) => item.instanceId,
      ),
    ).toEqual(["codex"]);
    expect(
      providerInstancesForProjectScope({ entries, scope: "work", aixProfile: "ac" }).map(
        (item) => item.instanceId,
      ),
    ).toEqual(["aix-codex-ac", "aix-opencode-ac"]);
    expect(
      providerInstancesForProjectScope({
        entries,
        scope: "work",
        aixProfile: "ac",
        selectedInstanceId: ProviderInstanceId.make("codex"),
      }).map((item) => item.instanceId),
    ).toEqual(["aix-codex-ac", "aix-opencode-ac", "codex"]);
  });

  it("filters models by project scope while retaining a selected model from the other scope", () => {
    expect(
      isPickerModelVisibleForProjectScope({
        scope: "personal",
        modelProfileId: "ac",
        isSelected: false,
      }),
    ).toBe(false);
    expect(
      isPickerModelVisibleForProjectScope({
        scope: "work",
        modelProfileId: "ac",
        selectedProfileId: "ac",
        isSelected: false,
      }),
    ).toBe(true);
    expect(
      isPickerModelVisibleForProjectScope({
        scope: "work",
        modelProfileId: "other",
        selectedProfileId: "ac",
        isSelected: false,
      }),
    ).toBe(false);
    expect(
      isPickerModelVisibleForProjectScope({
        scope: "work",
        modelProfileId: undefined,
        selectedProfileId: "ac",
        isSelected: true,
      }),
    ).toBe(true);
  });

  it("falls back from a missing remembered profile to the selected model then the first profile", () => {
    const profiles = groupAixProviderProfiles(entries);
    expect(
      resolveAixProfileId({
        profiles,
        rememberedProfileId: "removed",
        selectedModelProfileId: "personal",
      }),
    ).toBe("personal");
    expect(resolveAixProfileId({ profiles, rememberedProfileId: "removed" })).toBe("ac");
  });

  it("uses profile labels when present and falls back to ids on older server data", () => {
    const labels = aixProfileLabels([
      entry("aix-codex-ac", "codex", "ac", "adCare"),
      entry("aix-codex-personal", "codex", "personal"),
    ]);
    expect(aixProfileLabel("ac", labels)).toBe("adCare");
    expect(aixProfileLabel("personal", labels)).toBe("personal");
  });

  it("resolves new draft defaults into the project scope", () => {
    const providers = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "gpt-default", isDefault: true }, { slug: "gpt-6.1" }],
      },
      {
        instanceId: ProviderInstanceId.make("aix-codex-ac"),
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        aixProfile: "ac",
        models: [{ slug: "gpt-6.1" }],
      },
      {
        instanceId: ProviderInstanceId.make("aix-opencode-ac"),
        driver: ProviderDriverKind.make("opencode"),
        enabled: true,
        installed: true,
        status: "ready",
        aixProfile: "ac",
        models: [{ slug: "gemma-default", isDefault: true }, { slug: "gemma" }],
      },
    ];
    const normalDefault = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1" };
    expect(resolveScopedDraftModelSelection({ scope: "work", normalDefault, providers })).toEqual({
      instanceId: ProviderInstanceId.make("aix-codex-ac"),
      model: "gpt-6.1",
    });
    expect(
      resolveScopedDraftModelSelection({
        scope: "work",
        normalDefault: { instanceId: ProviderInstanceId.make("codex"), model: "missing" },
        providers,
      }),
    ).toEqual({
      instanceId: ProviderInstanceId.make("aix-codex-ac"),
      model: "gpt-6.1",
    });
    expect(
      resolveScopedDraftModelSelection({
        scope: "personal",
        normalDefault: {
          instanceId: ProviderInstanceId.make("aix-codex-ac"),
          model: "gpt-6.1",
        },
        providers,
      }),
    ).toEqual({ instanceId: ProviderInstanceId.make("codex"), model: "gpt-default" });
  });
});
