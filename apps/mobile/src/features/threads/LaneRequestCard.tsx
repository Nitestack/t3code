import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem, ThreadId } from "@t3tools/contracts";
import { threadAllowedLanes } from "@t3tools/shared/modelLanes";
import { useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useThreadShell } from "../../state/entities";
import { modelLaneRequestEnvironment } from "../../state/modelLaneRequests";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { laneTitle } from "../../lib/modelLaneCopy";

type LaneRequestItem = Extract<
  OrchestrationV2ProjectedTurnItem["item"],
  { readonly type: "lane_request" }
>;

/**
 * Feed card for a provider on a lane the thread may not use. The user answers
 * it here; its outcome stays on the card, and "for this thread" can be revoked.
 */
export function LaneRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item } = props.projectedItem;
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ?? [];
  if (item.type !== "lane_request") return null;
  const title = laneTitle(item.lane, providers);
  if (item.laneStatus === "pending") {
    return (
      <PendingLaneRequest
        environmentId={props.environmentId}
        threadId={props.threadId}
        item={item}
        title={title}
      />
    );
  }
  return (
    <ResolvedLaneRequest
      environmentId={props.environmentId}
      threadId={props.threadId}
      item={item}
      title={title}
      iconColor={props.iconColor}
    />
  );
}

function PendingLaneRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly item: LaneRequestItem;
  readonly title: string;
}) {
  const { item } = props;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = useAtomCommand(modelLaneRequestEnvironment.answer, {
    label: "answer lane request",
    reportFailure: false,
    reportDefect: false,
  });
  const canAnswer = useAtomValue(
    modelLaneRequestEnvironment.answer.permissionAtom(props.environmentId),
  );

  const submit = async (type: "allow-task" | "allow-thread" | "deny") => {
    setPending(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        turnItemId: item.id,
        answer: { type },
      },
    }).finally(() => setPending(false));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not answer the request.");
    }
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">
          Use {item.providerLabel} on {props.title}?
        </Text>
        {item.reason.trim() ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">{item.reason}</Text>
        ) : null}
      </View>
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      {canAnswer ? (
        <>
          <Button
            label="Allow for this thread"
            disabled={pending}
            onPress={() => void submit("allow-thread")}
            tone="primary"
            fullWidth
          />
          <Button
            label="Allow this task"
            disabled={pending}
            onPress={() => void submit("allow-task")}
            tone="secondary"
            fullWidth
          />
          <View className="flex-row justify-end">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: pending }}
              disabled={pending}
              hitSlop={8}
              className="px-1 py-1 active:opacity-60 disabled:opacity-50"
              onPress={() => void submit("deny")}
            >
              <Text className="font-sans text-xs text-foreground-muted">Deny</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <Text className="font-sans text-xs text-foreground-muted">
          This session cannot answer this request.
        </Text>
      )}
    </View>
  );
}

function ResolvedLaneRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly item: LaneRequestItem;
  readonly title: string;
  readonly iconColor: ColorValue;
}) {
  const { item } = props;
  const thread = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [revoking, setRevoking] = useState(false);
  const grantedHere =
    item.laneStatus === "allowed_thread" &&
    thread !== null &&
    threadAllowedLanes(thread).some((lane) => lane === item.lane);
  const revoked = item.laneStatus === "allowed_thread" && thread !== null && !grantedHere;

  const revoke = async () => {
    if (thread === null) return;
    setRevoking(true);
    const remaining = threadAllowedLanes(thread).filter((lane) => lane !== item.lane);
    const result = await updateMetadata({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, allowedLanes: remaining },
    }).finally(() => setRevoking(false));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not revoke",
        failure instanceof Error ? failure.message : "The lane could not be revoked.",
      );
    }
  };

  const outcome = resolvedOutcome(item.laneStatus, revoked);
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name={outcome.icon} size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {outcome.label(props.title)}
      </Text>
      {grantedHere ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: revoking }}
          disabled={revoking}
          hitSlop={8}
          className="px-1 py-1 active:opacity-60 disabled:opacity-50"
          onPress={() => void revoke()}
        >
          <Text className="font-sans text-xs text-foreground-muted">Revoke</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function resolvedOutcome(
  status: LaneRequestItem["laneStatus"],
  revoked: boolean,
): { readonly icon: AppSymbolName; readonly label: (title: string) => string } {
  if (status === "allowed_thread") {
    return revoked
      ? { icon: "minus", label: (title) => `Revoked ${title} for this thread` }
      : { icon: "checkmark", label: (title) => `Allowed ${title} for this thread` };
  }
  if (status === "allowed_task") {
    return { icon: "checkmark", label: (title) => `Allowed ${title} for this task` };
  }
  if (status === "denied") {
    return { icon: "xmark", label: (title) => `Denied ${title}` };
  }
  return { icon: "minus", label: (title) => `Cancelled ${title} request` };
}
