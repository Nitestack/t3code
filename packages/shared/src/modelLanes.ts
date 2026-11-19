export type ModelLane = "personal" | `aix:${string}`;

export interface ModelLaneInstance {
  readonly aixProfile?: string | undefined;
  readonly config?: unknown;
}

export interface ModelLaneProject {
  readonly scope?: "personal" | "work" | undefined;
  readonly homeAixProfile?: string | null | undefined;
}

export function laneOfInstance(instance: ModelLaneInstance): ModelLane {
  const config = instance.config;
  const configuredProfile =
    typeof config === "object" && config !== null && "aixProfile" in config
      ? config.aixProfile
      : undefined;
  const profile =
    instance.aixProfile ?? (typeof configuredProfile === "string" ? configuredProfile : undefined);
  return profile === undefined ? "personal" : `aix:${profile}`;
}

export function projectHomeLane(project: ModelLaneProject): ModelLane | null {
  if (project.scope !== "work") return "personal";
  return project.homeAixProfile == null ? null : `aix:${project.homeAixProfile}`;
}

export function isLaneAllowed(
  project: ModelLaneProject,
  allowedLanes: ReadonlyArray<string> | undefined,
  lane: string,
): boolean {
  return projectHomeLane(project) === lane || (allowedLanes ?? []).includes(lane);
}

export function allowedLanesForProject(
  project: ModelLaneProject,
  allowedLanes: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const grants = allowedLanes ?? [];
  const home = projectHomeLane(project);
  return home === null || grants.includes(home) ? grants : [home, ...grants];
}

/** aix instances are named `aix-<driver>-<profile>` by ProviderInstanceSync; driver kinds have no dash. */
export function laneOfInstanceId(instanceId: string): ModelLane {
  const match = /^aix-[^-]+-(.+)$/.exec(instanceId);
  return match?.[1] === undefined ? "personal" : `aix:${match[1]}`;
}

/** Threads from before lanes existed keep the lane of their current model. */
export function threadAllowedLanes<L extends string>(thread: {
  readonly allowedLanes?: ReadonlyArray<L> | undefined;
  readonly modelSelection: { readonly instanceId: string };
}): ReadonlyArray<L | ModelLane> {
  return thread.allowedLanes ?? [laneOfInstanceId(thread.modelSelection.instanceId)];
}
