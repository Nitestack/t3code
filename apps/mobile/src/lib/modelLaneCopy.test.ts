import { describe, expect, it } from "vite-plus/test";

import { laneKeyName, laneTitle, sendLaneConfirmCopy } from "./modelLaneCopy";

const providers = [
  { aixProfile: "persoenlich", aixProfileLabel: "Persönlich" },
  { aixProfile: "adcare" },
];

describe("lane names", () => {
  it.each([
    ["personal", "Personal", "Personal"],
    ["aix:persoenlich", "Persönlich", "Work · Persönlich"],
    ["aix:adcare", "adcare", "Work · adcare"],
    ["aix:unknown", "unknown", "Work · unknown"],
  ] as const)("names %s", (lane, keyName, title) => {
    expect(laneKeyName(lane, providers)).toBe(keyName);
    expect(laneTitle(lane, providers)).toBe(title);
  });
});

describe("sendLaneConfirmCopy", () => {
  it("names the key and the project's home key", () => {
    expect(
      sendLaneConfirmCopy({
        projectTitle: "loom",
        homeName: "Persönlich",
        lane: "aix:adcare",
        keyName: "adcare",
      }),
    ).toEqual({
      title: "Use the adcare key in loom?",
      message: "loom uses Persönlich. This thread would use adcare from now on.",
      confirmText: "Use adcare in this thread",
    });
  });

  it("says a project without a work key has none yet", () => {
    expect(
      sendLaneConfirmCopy({
        projectTitle: "loom",
        homeName: null,
        lane: "aix:adcare",
        keyName: "adcare",
      }).message,
    ).toBe("loom has no work key yet. This thread would use adcare from now on.");
  });

  it("does not call the personal account a key", () => {
    expect(
      sendLaneConfirmCopy({
        projectTitle: "loom",
        homeName: "Persönlich",
        lane: "personal",
        keyName: "Personal",
      }).title,
    ).toBe("Use Personal in loom?");
  });
});
