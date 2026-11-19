import {
  isLaneAllowed,
  laneOfInstanceId,
  threadAllowedLanes,
  type ModelLaneProject,
} from "@t3tools/shared/modelLanes";

/**
 * Lanes a send would put the thread on that it isn't allowed yet. A draft has no
 * grants, so only the project's home lane is allowed there.
 */
export function sendLanesNeedingConfirm(input: {
  readonly project: ModelLaneProject;
  readonly thread: Parameters<typeof threadAllowedLanes>[0] | null;
  readonly instanceIds: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const grants = input.thread ? threadAllowedLanes(input.thread) : undefined;
  const lanes = new Set<string>();
  for (const instanceId of input.instanceIds) {
    const lane = laneOfInstanceId(instanceId);
    if (!isLaneAllowed(input.project, grants, lane)) lanes.add(lane);
  }
  return [...lanes];
}

export function aixProfileLabels(
  entries: ReadonlyArray<{
    readonly aixProfile?: string | undefined;
    readonly aixProfileLabel?: string | undefined;
  }>,
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.aixProfile && entry.aixProfileLabel)
      labels.set(entry.aixProfile, entry.aixProfileLabel);
  }
  return labels;
}

export function laneLabel(lane: string, profileLabels?: ReadonlyMap<string, string>): string {
  if (lane === "personal") return "Personal";
  const profile = lane.slice("aix:".length);
  return `Work · ${profileLabels?.get(profile) ?? profile}`;
}
