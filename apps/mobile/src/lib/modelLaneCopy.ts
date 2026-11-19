import type { ModelLane } from "@t3tools/contracts";

type LaneProvider = {
  readonly aixProfile?: string | undefined;
  readonly aixProfileLabel?: string | undefined;
};

/** What a lane is called: "Personal", or the work key's name. */
export function laneKeyName(lane: ModelLane, providers: ReadonlyArray<LaneProvider>): string {
  if (lane === "personal") return "Personal";
  const profileId = lane.slice("aix:".length);
  return (
    providers.find((provider) => provider.aixProfile === profileId)?.aixProfileLabel ?? profileId
  );
}

/** A lane with its kind, as cards name it: "Personal" or "Work · <key>". */
export function laneTitle(lane: ModelLane, providers: ReadonlyArray<LaneProvider>): string {
  const name = laneKeyName(lane, providers);
  return lane === "personal" ? name : `Work · ${name}`;
}

/** The send confirm: `homeName` is the project's home key, or null while the project has none. */
export function sendLaneConfirmCopy(input: {
  readonly projectTitle: string;
  readonly homeName: string | null;
  readonly lane: ModelLane;
  readonly keyName: string;
}) {
  const { projectTitle, homeName, lane, keyName } = input;
  return {
    title:
      lane === "personal"
        ? `Use Personal in ${projectTitle}?`
        : `Use the ${keyName} key in ${projectTitle}?`,
    message: `${projectTitle} ${homeName === null ? "has no work key yet" : `uses ${homeName}`}. This thread would use ${keyName} from now on.`,
    confirmText: `Use ${keyName} in this thread`,
  };
}
