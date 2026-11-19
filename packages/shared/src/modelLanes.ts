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
