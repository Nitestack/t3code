import type { ModelLane, ProjectId } from "@t3tools/contracts";
import {
  allowedLanesForProject,
  laneOfInstance,
  projectHomeLane,
  threadAllowedLanes,
} from "@t3tools/shared/modelLanes";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import type { Thread } from "../../types";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { composerFloatingLayerProps } from "./composerEventScope";
import { aixProfileLabels, laneLabel } from "./modelLanes.logic";

export function ComposerLaneRows(props: {
  thread: Thread | undefined;
  /** Used before the first send, when there is no thread yet. */
  draftId: DraftId | null;
  projectId: ProjectId | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const projects = useProjects();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const { thread, draftId } = props;
  const draft = useComposerDraftStore((store) =>
    thread || !draftId ? null : (store.draftThreadsByThreadKey[draftId] ?? null),
  );
  const environmentId = thread?.environmentId ?? draft?.environmentId;
  const project = projects.find(
    (candidate) => candidate.id === props.projectId && candidate.environmentId === environmentId,
  );
  if (!project || (!thread && !draft)) return null;

  const home = projectHomeLane(project);
  const grants = (thread ? threadAllowedLanes(thread) : (draft?.allowedLanes ?? [])).filter(
    (lane) => lane !== home,
  );
  const lanes = allowedLanesForProject(project, grants);
  const others = [
    ...new Set(
      props.instanceEntries.filter((entry) => entry.enabled).map((entry) => laneOfInstance(entry)),
    ),
  ].filter((lane) => !lanes.includes(lane));

  const profileLabels = aixProfileLabels(props.instanceEntries);
  const saveGrants = (next: ReadonlyArray<ModelLane>) => {
    if (thread) {
      void updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, allowedLanes: next },
      });
    } else if (draftId) {
      setDraftThreadContext(draftId, { allowedLanes: next });
    }
  };

  return (
    // contain:inline-size: long key names truncate instead of widening the picker.
    <div className="flex w-full flex-col items-start gap-1 border-b border-border/70 pb-2 text-xs text-muted-foreground [contain:inline-size]">
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
