import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  composerMenuCandidatesForScope,
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
  type ComposerThreadCandidate,
} from "./composerThreadItems.ts";

const environmentId = EnvironmentId.make("env-composer");

function shell(
  id: string,
  title: string,
  overrides: Partial<ComposerThreadCandidate> = {},
): ComposerThreadCandidate {
  return {
    environmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    opens: null,
    archivedAt: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

it("ranks thread mentions like the palette and leaves out subagent threads", () => {
  const items = matchComposerThreadItems({
    shells: [
      shell("newer-mid-word", "Remodel the settings page", {
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
      shell("word", "Fix model picker"),
      shell("subagent", "Model review", {
        lineage: {
          rootThreadId: ThreadId.make("word"),
          parentThreadId: ThreadId.make("word"),
          relationshipToParent: "subagent",
        },
      }),
      shell("other-environment", "Model docs", { environmentId: EnvironmentId.make("env-other") }),
    ],
    environmentId,
    linkedEnvironments: new Map(),
    excludeThreadId: null,
    query: "model",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map((item) => item.thread.threadId)).toEqual(["word", "newer-mid-word"]);
});

it("also offers threads on linked machines, naming the machine, but no other machine's", () => {
  const vps = EnvironmentId.make("env-vps");
  const items = matchComposerThreadItems({
    shells: [
      shell("here", "Deploy script"),
      shell("there", "Deploy script", { environmentId: vps }),
      shell("unlinked", "Deploy notes", { environmentId: EnvironmentId.make("env-unlinked") }),
    ],
    environmentId,
    linkedEnvironments: new Map([[vps, "Hetzner VPS"]]),
    excludeThreadId: null,
    query: "deploy",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map(({ thread, label, description }) => ({ thread, label, description }))).toEqual([
    { thread: { environmentId, threadId: "here" }, label: "Deploy script", description: "Thread" },
    {
      thread: { environmentId: vps, threadId: "there" },
      label: "Deploy script",
      description: "Thread on Hetzner VPS",
    },
  ]);
});

it("keeps composer mentions in the active environment scope as it changes", () => {
  const work = EnvironmentId.make("env-work");
  const personal = EnvironmentId.make("env-personal");
  // The shared list can still contain cached results from the other scope after a switch.
  const shells = [
    shell("work-thread", "Deploy the work app", { environmentId: work }),
    shell("personal-thread", "Deploy the personal app", { environmentId: personal }),
  ];
  const linkedEnvironments = new Map([[personal, "Personal server"]]);
  const environments = [
    { environmentId: work, label: "Work server", machine: "cloud" as const },
    { environmentId: personal, label: "Personal server", machine: "laptop" as const },
  ];
  const assignments = { [work]: "work", [personal]: "personal" } as const;
  const candidates = (scope: "work" | "personal" | null) =>
    composerMenuCandidatesForScope({
      environmentId: work,
      linkedEnvironments,
      shells,
      environments,
      scope,
      assignments,
    });
  const mentionsFor = (scope: "work" | "personal" | null) => {
    const scoped = candidates(scope);
    return {
      searchEnvironmentIds: scoped.searchEnvironmentIds,
      threadIds: matchComposerThreadItems({
        shells: scoped.shells,
        environmentId: work,
        linkedEnvironments: scoped.linkedEnvironments,
        excludeThreadId: null,
        query: "deploy",
        now: Date.parse("2026-10-23T00:00:00.000Z"),
      }).map(({ thread }) => thread.threadId),
      environmentIds: matchComposerEnvironmentItems({
        environments: scoped.environments,
        environmentId: work,
        query: "server",
      }).map(({ environmentId }) => environmentId),
    };
  };

  expect(mentionsFor("work")).toEqual({
    searchEnvironmentIds: [work],
    threadIds: ["work-thread"],
    environmentIds: [],
  });
  expect(mentionsFor("personal")).toEqual({
    searchEnvironmentIds: [personal],
    threadIds: ["personal-thread"],
    environmentIds: [personal],
  });
  // Mobile's feature-disabled path keeps its existing unscoped behavior.
  expect(mentionsFor(null)).toEqual({
    searchEnvironmentIds: [work, personal],
    threadIds: ["work-thread", "personal-thread"],
    environmentIds: [personal],
  });
});

describe("matchComposerEnvironmentItems", () => {
  const environments = [
    { environmentId: EnvironmentId.make("env-here"), label: "Laptop", machine: "laptop" },
    { environmentId: EnvironmentId.make("env-vps"), label: "Hetzner VPS", machine: "cloud" },
    { environmentId: EnvironmentId.make("env-mini"), label: "Mac mini", machine: "mac-mini" },
  ] as const;

  it("offers the other machines matching the query, never the composer's own", () => {
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "  vps ",
      }),
    ).toEqual([
      {
        id: "environment:env-vps",
        type: "environment",
        environmentId: "env-vps",
        machine: "cloud",
        label: "Hetzner VPS",
        description: "Machine",
      },
    ]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "lap",
      }),
    ).toEqual([]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "",
      }),
    ).toEqual([]);
  });
});
