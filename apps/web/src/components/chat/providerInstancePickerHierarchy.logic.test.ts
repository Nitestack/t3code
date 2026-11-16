import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  groupAixProviderProfiles,
  providerInstanceForPickerSelection,
  providerInstancesForPickerLevel,
} from "./providerInstancePickerHierarchy";

const entry = (instanceId: string, driver: string, profile?: string, label?: string) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driverKind: ProviderDriverKind.make(driver),
  ...(profile ? { aixProfile: profile, aixProfileLabel: label } : {}),
});

describe("provider picker hierarchy", () => {
  const entries = [
    entry("codex", "codex"),
    entry("aix-codex-ac", "codex", "ac", "adCare"),
    entry("aix-opencode-ac", "opencode", "ac", "adCare"),
    entry("aix-codex-personal", "codex", "personal", "Persönlich"),
  ];

  it("shows each aix harness once inside its profile", () => {
    expect(groupAixProviderProfiles(entries)).toEqual([
      { id: "ac", label: "adCare", entries: [entries[1], entries[2]] },
      { id: "personal", label: "Persönlich", entries: [entries[3]] },
    ]);
  });

  it("separates every aix instance, including Persönlich, from subscriptions", () => {
    expect(
      providerInstancesForPickerLevel({ entries, scope: "subscriptions" }).map(
        (item) => item.instanceId,
      ),
    ).toEqual(["codex"]);
    expect(
      providerInstancesForPickerLevel({ entries, scope: "aix", aixProfile: "personal" }).map(
        (item) => item.instanceId,
      ),
    ).toEqual(["aix-codex-personal"]);
    expect(
      providerInstancesForPickerLevel({ entries, scope: "aix", aixProfile: "missing" }),
    ).toEqual([]);
    expect(groupAixProviderProfiles([entries[0]!])).toEqual([]);
  });

  it("maps a profile and harness selection to the exact provider instance", () => {
    expect(
      providerInstanceForPickerSelection({
        entries,
        scope: "aix",
        aixProfile: "ac",
        preferredDriver: ProviderDriverKind.make("codex"),
      })?.instanceId,
    ).toBe("aix-codex-ac");
  });
});
