import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  providerSettingsRowLabels,
  resolveProviderSettingsHierarchy,
  type ProviderSettingsEntry,
} from "./providerSettingsHierarchy.ts";

const entry = (
  instanceId: string,
  driver: string,
  profile?: string,
  profileLabel?: string,
  displayName?: string,
): ProviderSettingsEntry => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driverKind: ProviderDriverKind.make(driver),
  driverLabel: driver,
  enabled: true,
  status: "Available",
  ...(profile ? { aixProfile: profile, aixProfileLabel: profileLabel } : {}),
  ...(displayName ? { displayName } : {}),
});

describe("provider settings hierarchy", () => {
  const entries = [
    entry("codex", "codex"),
    entry("aix-codex-adcare", "codex", "adcare", "adCare"),
    entry("aix-opencode-adcare", "opencode", "adcare", "adCare"),
    entry("aix-codex-nimbl", "codex", "nimbl", "NIMBL"),
  ];

  it("splits personal and work instances and filters by profile", () => {
    expect(
      resolveProviderSettingsHierarchy({ entries, scope: "personal" }).visibleEntries.map(
        (item) => item.instanceId,
      ),
    ).toEqual(["codex"]);
    const work = resolveProviderSettingsHierarchy({
      entries,
      scope: "work",
      profileId: "adcare",
    });
    expect(work.visibleEntries.map((item) => item.instanceId)).toEqual([
      "aix-codex-adcare",
      "aix-opencode-adcare",
    ]);
    expect(work.profiles.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "adcare", label: "adCare" },
      { id: "nimbl", label: "NIMBL" },
    ]);
  });

  it("falls back to the first profile when the requested one is gone", () => {
    const work = resolveProviderSettingsHierarchy({ entries, scope: "work", profileId: "ae" });
    expect(work.profileId).toBe("adcare");
    expect(work.visibleEntries.map((item) => item.instanceId)).toEqual([
      "aix-codex-adcare",
      "aix-opencode-adcare",
    ]);
  });

  it("hides the scope switch when no aix profiles exist", () => {
    const hierarchy = resolveProviderSettingsHierarchy({ entries: [entries[0]!], scope: "work" });
    expect(hierarchy.hasAixProfiles).toBe(false);
    expect(hierarchy.visibleEntries.map((item) => item.instanceId)).toEqual(["codex"]);
  });

  it("formats consistent row titles, versions, status, and source", () => {
    expect(
      providerSettingsRowLabels({
        driverLabel: "Codex",
        displayName: "  My Codex  ",
        version: "0.2.1",
        status: "Available",
        accountSource: "API key",
      }),
    ).toEqual({ title: "My Codex", version: "0.2.1", detail: "Available · API key" });
    expect(
      providerSettingsRowLabels({
        driverLabel: "Codex",
        displayName: "adCare · Codex",
        isAix: true,
        status: "Available",
      }).title,
    ).toBe("Codex");
    expect(
      providerSettingsRowLabels({
        driverLabel: "Claude Code",
        version: null,
        status: "Authenticated · ChatGPT Plus Subscription",
      }),
    ).toEqual({
      title: "Claude Code",
      version: null,
      detail: "Authenticated · ChatGPT Plus Subscription",
    });
  });
});
