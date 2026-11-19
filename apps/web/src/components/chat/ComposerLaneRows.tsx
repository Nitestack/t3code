import type { ProjectId } from "@t3tools/contracts";
import {
  allowedLanesForProject,
  laneOfInstance,
  projectHomeLane,
  threadAllowedLanes,
} from "@t3tools/shared/modelLanes";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import type { Thread } from "../../types";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { composerFloatingLayerProps } from "./composerEventScope";
import { aixProfileLabels, laneLabel } from "./modelLanes.logic";

/** Drafts have no thread to grant lanes to yet, so they show nothing here. */
export function ComposerLaneRows(props: {
  thread: Thread | undefined;
  projectId: ProjectId | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const projects = useProjects();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata);
  const { thread } = props;
  const project = projects.find(
    (candidate) =>
      candidate.id === props.projectId && candidate.environmentId === thread?.environmentId,
  );
  if (!thread || !project) return null;

  const home = projectHomeLane(project);
  const grants = threadAllowedLanes(thread).filter((lane) => lane !== home);
  const lanes = allowedLanesForProject(project, grants);
  const others = [
    ...new Set(
      props.instanceEntries.filter((entry) => entry.enabled).map((entry) => laneOfInstance(entry)),
    ),
  ].filter((lane) => !lanes.includes(lane));

  const profileLabels = aixProfileLabels(props.instanceEntries);
  const saveGrants = (next: ReadonlyArray<string>) => {
    void updateThreadMetadata({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, allowedLanes: next },
    });
  };

  return (
    <div className="flex w-full flex-col items-start gap-1 border-b border-border/70 pb-2 text-xs text-muted-foreground">
      <span>Agents in this thread may use</span>
      {lanes.map((lane) => (
        <div key={lane} className="flex w-full items-center justify-between gap-2">
          <span className="truncate text-foreground">
            {laneLabel(lane, profileLabels)}
            {lane === home ? " · project key" : null}
          </span>
          {lane === home ? null : (
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => saveGrants(grants.filter((granted) => granted !== lane))}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {others.length > 0 ? (
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="ghost-muted" />}>
            Allow another key…
          </MenuTrigger>
          <MenuPopup side="top" align="start" {...composerFloatingLayerProps}>
            {others.map((lane) => (
              <MenuItem key={lane} onClick={() => saveGrants([...grants, lane])}>
                {laneLabel(lane, profileLabels)}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
