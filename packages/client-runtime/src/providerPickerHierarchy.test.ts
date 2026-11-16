import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  aixMetadataFromInstanceId,
  aixProfileLabel,
  aixProfileLabels,
  groupAixProviderProfiles,
  isModelSelectionInProjectScope,
  resolveDraftModelSelectionAfterUsageLimitFallback,
  isPickerModelVisibleForProjectScope,
  pickerFilterIsFavorites,
  pickerFilterProfileId,
  pickerFilterProviderKey,
  providerInstancesForProjectScope,
  resolveDraftModelSelectionForScope,
  resolveModelPickerProjectScope,
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
    expect(
      providerInstancesForProjectScope({
        entries,
        scope: "personal",
        selectedInstanceId: ProviderInstanceId.make("aix-codex-ac"),
      }).map((item) => item.instanceId),
    ).toEqual(["codex", "aix-codex-ac"]);
  });

  it("resolves project picker scope only when the environment supports it", () => {
    expect(resolveModelPickerProjectScope("work", true)).toBe("work");
    expect(resolveModelPickerProjectScope("personal", true)).toBe("personal");
    expect(resolveModelPickerProjectScope("work", false)).toBe("personal");
    expect(resolveModelPickerProjectScope("unknown", true)).toBe("personal");
  });

  it("classifies selections by aix metadata or instance id while config is loading", () => {
    expect(
      isModelSelectionInProjectScope({
        scope: "personal",
        selection: { instanceId: ProviderInstanceId.make("aix-codex-team"), model: "gpt" },
        providers: [],
      }),
    ).toBe(false);
    expect(
      isModelSelectionInProjectScope({
        scope: "work",
        selection: { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt" },
        providers: [{ instanceId: ProviderInstanceId.make("codex-work"), aixProfile: "team" }],
      }),
    ).toBe(true);
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
    expect(resolveDraftModelSelectionForScope({ scope: "work", normalDefault, providers })).toEqual(
      { instanceId: ProviderInstanceId.make("aix-codex-ac"), model: "gpt-6.1" },
    );
    expect(
      resolveDraftModelSelectionForScope({
        scope: "work",
        normalDefault: { instanceId: ProviderInstanceId.make("codex"), model: "missing" },
        providers,
      }),
    ).toEqual({
      instanceId: ProviderInstanceId.make("aix-codex-ac"),
      model: "gpt-6.1",
    });
    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        normalDefault: {
          instanceId: ProviderInstanceId.make("aix-codex-ac"),
          model: "gpt-6.1",
        },
        providers,
      }),
    ).toEqual({ instanceId: ProviderInstanceId.make("codex"), model: "gpt-default" });
  });

  it("keeps usage-limit fallbacks in scope and never restores the exhausted selection", () => {
    const personal = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      status: "ready",
      models: [{ slug: "gpt-default", isDefault: true }],
    };
    const aix = {
      instanceId: ProviderInstanceId.make("aix-codex-team"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      status: "ready",
      aixProfile: "team",
      models: [{ slug: "work-default", isDefault: true }],
    };
    const alternatePersonal = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      status: "ready",
      models: [{ slug: "claude-default", isDefault: true }],
    };
    const exhausted = { instanceId: personal.instanceId, model: "gpt-default" };

    expect(
      resolveDraftModelSelectionAfterUsageLimitFallback({
        scope: "personal",
        exhaustedSelection: exhausted,
        fallbackSelection: { instanceId: aix.instanceId, model: "work-default" },
        normalDefault: exhausted,
        providers: [personal, aix],
      }),
    ).toBeNull();

    expect(
      resolveDraftModelSelectionAfterUsageLimitFallback({
        scope: "personal",
        exhaustedSelection: exhausted,
        fallbackSelection: { instanceId: aix.instanceId, model: "work-default" },
        normalDefault: exhausted,
        providers: [personal, aix, alternatePersonal],
      }),
    ).toEqual({ instanceId: alternatePersonal.instanceId, model: "claude-default" });

    expect(
      resolveDraftModelSelectionAfterUsageLimitFallback({
        scope: "work",
        exhaustedSelection: exhausted,
        fallbackSelection: { instanceId: aix.instanceId, model: "work-default" },
        providers: [personal, aix],
      }),
    ).toEqual({ instanceId: aix.instanceId, model: "work-default" });

    expect(
      resolveDraftModelSelectionAfterUsageLimitFallback({
        scope: "personal",
        exhaustedSelection: { instanceId: personal.instanceId, model: "gpt-default" },
        fallbackSelection: { instanceId: personal.instanceId, model: "gpt-sibling" },
        providers: [{ ...personal, models: [...personal.models, { slug: "gpt-sibling" }] }],
      }),
    ).toBeNull();
  });

  it("uses a sticky selection only when it belongs to the draft scope", () => {
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
        models: [{ slug: "gpt-aix-default", isDefault: true }, { slug: "gpt-6.1" }],
      },
    ];
    const personalSticky = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.1",
    };
    const workSticky = {
      instanceId: ProviderInstanceId.make("aix-codex-ac"),
      model: "gpt-6.1",
    };

    expect(
      resolveDraftModelSelectionForScope({
        scope: "work",
        stickySelection: personalSticky,
        normalDefault: personalSticky,
        providers,
      }),
    ).toEqual({ instanceId: ProviderInstanceId.make("aix-codex-ac"), model: "gpt-aix-default" });
    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        stickySelection: workSticky,
        normalDefault: workSticky,
        providers,
      }),
    ).toEqual({ instanceId: ProviderInstanceId.make("codex"), model: "gpt-default" });
    expect(
      resolveDraftModelSelectionForScope({
        scope: "work",
        stickySelection: workSticky,
        normalDefault: null,
        providers,
      }),
    ).toEqual(workSticky);
    expect(
      resolveDraftModelSelectionForScope({
        scope: "work",
        explicitSelection: personalSticky,
        stickySelection: workSticky,
        normalDefault: null,
        providers,
      }),
    ).toEqual(personalSticky);
  });

  it("resolves new draft selection in explicit, configured, sticky, then ready-provider order", () => {
    const providers = [
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "personal-default", isDefault: true }, { slug: "personal-last" }],
      },
      {
        instanceId: ProviderInstanceId.make("aix-codex-team"),
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        aixProfile: "team",
        models: [{ slug: "work-default", isDefault: true }, { slug: "work-last" }],
      },
      {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "claude-default", isDefault: true }],
      },
    ];
    const selection = (instanceId: string, model: string) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      model,
    });

    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        explicitSelection: selection("aix-codex-team", "explicit"),
        normalDefault: selection("codex", "configured"),
        stickySelection: selection("claudeAgent", "sticky"),
        providers,
      }),
    ).toEqual(selection("aix-codex-team", "explicit"));

    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        normalDefault: selection("codex", "configured"),
        stickySelection: selection("claudeAgent", "sticky"),
        providers,
      }),
    ).toEqual(selection("codex", "configured"));

    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        normalDefault: selection("aix-codex-team", "wrong-scope"),
        stickySelection: selection("claudeAgent", "sticky"),
        providers,
      }),
    ).toEqual(selection("claudeAgent", "sticky"));

    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        carriedSelection: selection("claudeAgent", "carried"),
        normalDefault: selection("codex", "configured"),
        stickySelection: selection("claudeAgent", "sticky"),
        providers,
      }),
    ).toEqual(selection("claudeAgent", "carried"));

    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        carriedSelection: selection("codex", "not-ready-carry"),
        normalDefault: selection("codex", "configured"),
        providers: providers.map((provider) =>
          provider.instanceId === "codex" ? { ...provider, status: "warning" } : provider,
        ),
      }),
    ).toEqual(selection("claudeAgent", "claude-default"));

    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        carriedSelection: selection("aix-codex-team", "wrong-scope-carry"),
        normalDefault: selection("codex", "configured"),
        providers,
      }),
    ).toEqual(selection("codex", "configured"));

    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        orderedDefault: selection("codex", "personal-default"),
        stickySelection: selection("claudeAgent", "sticky"),
        providers,
      }),
    ).toEqual(selection("claudeAgent", "sticky"));

    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        orderedDefault: selection("claudeAgent", "ordered"),
        providers,
      }),
    ).toEqual(selection("claudeAgent", "ordered"));

    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        stickySelection: selection("codex", "disabled-sticky"),
        providers: providers.map((provider) =>
          provider.instanceId === "codex" ? { ...provider, enabled: false } : provider,
        ),
      }),
    ).toEqual(selection("claudeAgent", "claude-default"));

    expect(
      resolveDraftModelSelectionAfterUsageLimitFallback({
        scope: "personal",
        exhaustedSelection: selection("codex", "exhausted"),
        fallbackSelection: null,
        carriedSelection: selection("codex", "exhausted"),
        stickySelection: selection("claudeAgent", "sticky"),
        providers,
      }),
    ).toEqual(selection("claudeAgent", "sticky"));

    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        stickySelection: selection("aix-codex-team", "wrong-scope"),
        providers,
      }),
    ).toEqual(selection("codex", "personal-default"));

    expect(
      resolveDraftModelSelectionForScope({
        scope: "work",
        stickySelection: selection("aix-codex-team", "work-last"),
        providers,
      }),
    ).toEqual(selection("aix-codex-team", "work-last"));

    expect(
      resolveDraftModelSelectionForScope({
        scope: "personal",
        providers: [
          {
            instanceId: ProviderInstanceId.make("warning"),
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            status: "warning",
            models: [{ slug: "warning-default", isDefault: true }],
          },
        ],
      }),
    ).toBeNull();

    expect(
      resolveDraftModelSelectionForScope({
        scope: "work",
        providers: providers.filter((provider) => provider.aixProfile === undefined),
      }),
    ).toBeNull();
  });
});
