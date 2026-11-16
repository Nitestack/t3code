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

  it("keeps a selected instance visible when it is outside the current scope or profile", () => {
    const selectedWork = resolveProviderSettingsHierarchy({
      entries,
      scope: "personal",
      selectedInstanceId: ProviderInstanceId.make("aix-codex-nimbl"),
    });
    expect(selectedWork.scope).toBe("personal");
    expect(selectedWork.visibleEntries.map((item) => item.instanceId)).toEqual([
      "codex",
      "aix-codex-nimbl",
    ]);
    const selectedPersonal = resolveProviderSettingsHierarchy({
      entries,
      scope: "work",
      profileId: "adcare",
      selectedInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(selectedPersonal.scope).toBe("work");
    expect(selectedPersonal.visibleEntries.map((item) => item.instanceId)).toEqual([
      "aix-codex-adcare",
      "aix-opencode-adcare",
      "codex",
    ]);
    const selectedOtherProfile = resolveProviderSettingsHierarchy({
      entries,
      scope: "work",
      profileId: "adcare",
      selectedInstanceId: ProviderInstanceId.make("aix-codex-nimbl"),
    });
    expect(selectedOtherProfile.profileId).toBe("nimbl");
    expect(selectedOtherProfile.visibleEntries.map((item) => item.instanceId)).toEqual([
      "aix-codex-nimbl",
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
        accountSource: "aix adCare",
      }),
    ).toEqual({ title: "My Codex", version: "0.2.1", detail: "Available · aix adCare" });
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
