import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { projectScopeInput } from "@t3tools/client-runtime/environment";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, type ProjectScope } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { environmentServerConfigsAtom } from "../../state/server";

/** A No project thread that already has its own folder, on a server that can promote it. */
export function canTurnThreadIntoProject(thread: EnvironmentThreadShell): boolean {
  if (thread.worktreePath === null) return false;
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId);
  if (config?.environment.capabilities.threadProjectFromScratch !== true) return false;
  const project = appAtomRegistry.get(
    environmentProjects.projectAtom({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
    }),
  );
  return project?.isScratch === true;
}

export async function turnThreadIntoProject(
  thread: EnvironmentThreadShell,
  scope?: ProjectScope,
): Promise<void> {
  const title = m(msg("Could not turn thread into a project"));
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    Dialog.alert(title, m(msg("This connection cannot change threads.")));
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const result = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.createFromThread,
    {
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        ...(scope === undefined
          ? {}
          : projectScopeInput(
              appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId)
                ?.environment.capabilities,
              scope,
            )),
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, errorDisplayMessage(error, m) ?? m(msg("Try again.")));
  }
}
