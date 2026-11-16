import {
  isListedThreadLineage,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  filterByProjectScope,
  filterProjectsByScope,
  type EnvironmentScope,
} from "./environment/index.ts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage" | "projectId">;

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * Threads to reference from the composer, matched and ranked like the command
 * palette, without subagent or side chat threads. The agent reads threads on its own server
 * and on the machines it links to, so candidates stay within those, and a linked
 * machine's threads say which machine they are on.
 */
export function matchComposerThreadItems(input: {
  shells: ReadonlyArray<ComposerThreadCandidate>;
  environmentId: EnvironmentId;
  /** The machines the composer's environment links to, by name. */
  linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  excludeThreadId: ThreadId | null;
  query: string;
  /** Recency is measured against this time. */
  now: number;
}): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  const candidates = input.shells.filter(
    (shell) =>
      (shell.environmentId === input.environmentId ||
        input.linkedEnvironments.has(shell.environmentId)) &&
      shell.id !== input.excludeThreadId &&
      shell.archivedAt === null &&
      isListedThreadLineage(shell.lineage),
  );
  return rankSearchItems(candidates, (shell, options) =>
    scoreThreadSearch(query, threadSearchSubject(shell, null), input.now, {
      ...options,
      picks: false,
    }),
  )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map(({ item: shell }) => {
      const machine =
        shell.environmentId === input.environmentId
          ? undefined
          : input.linkedEnvironments.get(shell.environmentId);
      return {
        id: `thread:${shell.environmentId}:${shell.id}`,
        type: "thread",
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        label: shell.title,
        description: machine === undefined ? "Thread" : `Thread on ${machine}`,
      };
    });
}

export interface ComposerEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface ComposerEnvironmentItem {
  readonly id: string;
  readonly type: "environment";
  readonly environmentId: EnvironmentId;
  readonly machine: EnvironmentMachineKind;
  readonly label: string;
  readonly description: string;
}

/**
 * Scope the composer inputs together so cached thread shells, machine mentions, and search
 * requests all follow the same active environment scope.
 */
export function composerMenuCandidatesForScope(input: {
  readonly environmentId: EnvironmentId;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly shells: ReadonlyArray<ComposerThreadCandidate>;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly scope?: EnvironmentScope | undefined;
  }>;
  readonly environments: ReadonlyArray<ComposerEnvironmentCandidate>;
  /** Null keeps surfaces without the scope feature unfiltered. */
  readonly scope: EnvironmentScope | null;
}): {
  readonly searchEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly searchProjectIds?: ReadonlyArray<ProjectId>;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly shells: ReadonlyArray<ComposerThreadCandidate>;
  readonly environments: ReadonlyArray<ComposerEnvironmentCandidate>;
} {
  const searchTargets = [
    { environmentId: input.environmentId },
    ...Array.from(input.linkedEnvironments.keys(), (environmentId) => ({ environmentId })),
  ];
  if (input.scope === null) {
    return {
      searchEnvironmentIds: searchTargets.map(({ environmentId }) => environmentId),
      linkedEnvironments: input.linkedEnvironments,
      shells: input.shells,
      environments: input.environments,
    };
  }

  const scopedProjects = filterProjectsByScope(input.projects, input.scope);
  const searchEnvironmentIds = new Set(scopedProjects.map(({ environmentId }) => environmentId));
  return {
    searchEnvironmentIds: [...searchEnvironmentIds],
    searchProjectIds: scopedProjects.map(({ id }) => id),
    linkedEnvironments: new Map(
      [...input.linkedEnvironments].filter(([environmentId]) =>
        searchEnvironmentIds.has(environmentId),
      ),
    ),
    shells: filterByProjectScope(input.shells, input.scope, scopedProjects),
    environments: input.environments,
  };
}

/**
 * The user's machines the `@` picker offers, so the agent can link or work there. The
 * composer's own environment is left out. Like threads, they need a query: bare `@` stays a
 * file picker.
 */
export function matchComposerEnvironmentItems(input: {
  environments: ReadonlyArray<ComposerEnvironmentCandidate>;
  environmentId: EnvironmentId;
  query: string;
}): ComposerEnvironmentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  return input.environments
    .filter(
      (environment) =>
        environment.environmentId !== input.environmentId &&
        environment.label.toLowerCase().includes(query),
    )
    .map((environment) => ({
      id: `environment:${environment.environmentId}`,
      type: "environment",
      environmentId: environment.environmentId,
      machine: environment.machine,
      label: environment.label,
      description: "Machine",
    }));
}
