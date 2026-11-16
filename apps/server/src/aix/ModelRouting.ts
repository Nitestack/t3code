import { ProviderDriverKind } from "@t3tools/contracts";

import { type CatalogModel, knownNonChatId } from "./ModelCatalog.ts";

/** Routes the caller has established from the profile endpoint and its configured API. */
export type AixModelRoute =
  | "anthropic-direct-messages"
  | "litellm-anthropic-messages"
  | "litellm-openai-responses"
  | "litellm-openai-chat";

export type AixUnroutableReason =
  | "invalid-model-id"
  | "non-chat-model"
  | "route-unknown"
  | "claude-direct-only"
  | "no-native-agent";

export type AixModelRouting =
  | {
      readonly kind: "routed";
      readonly driverKind: ProviderDriverKind;
      readonly modelId: string;
      readonly displayName: string;
      readonly metadata: Omit<CatalogModel, "id" | "displayName">;
    }
  | {
      readonly kind: "unroutable";
      readonly modelId: string;
      readonly displayName: string;
      readonly reason: AixUnroutableReason;
    };

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE_CODE = ProviderDriverKind.make("claudeAgent");
const OPENCODE = ProviderDriverKind.make("opencode");

type AgentChoice =
  | { readonly driverKind: ProviderDriverKind }
  | { readonly reason: AixUnroutableReason };

function agentFor(id: string, routeKind: AixModelRoute): AgentChoice {
  const concrete = !id.includes("*");
  const claude = concrete && id.startsWith("claude-");
  switch (routeKind) {
    case "anthropic-direct-messages":
      return claude ? { driverKind: CLAUDE_CODE } : { reason: "claude-direct-only" };
    case "litellm-anthropic-messages":
      return claude ? { driverKind: CLAUDE_CODE } : { reason: "no-native-agent" };
    case "litellm-openai-responses":
      // gpt-oss is an open-weight chat model, not a Responses API model.
      return concrete && id.startsWith("gpt-") && !id.startsWith("gpt-oss")
        ? { driverKind: CODEX }
        : { reason: "no-native-agent" };
    case "litellm-openai-chat":
      return { driverKind: OPENCODE };
    default:
      return { reason: "route-unknown" };
  }
}

/** Chooses the native agent for a model's route; never retries or substitutes a model. */
export function routeCatalogModel(
  model: CatalogModel,
  input: { readonly route: AixModelRoute | undefined },
): AixModelRouting {
  const { id, displayName, ...metadata } = model;
  const unroutable = (reason: AixUnroutableReason): AixModelRouting => ({
    kind: "unroutable",
    modelId: id,
    displayName,
    reason,
  });

  if (id.trim().length === 0) return unroutable("invalid-model-id");
  if (knownNonChatId(id)) return unroutable("non-chat-model");
  if (input.route === undefined) return unroutable("route-unknown");

  const agent = agentFor(id, input.route);
  if ("reason" in agent) return unroutable(agent.reason);

  return {
    kind: "routed",
    driverKind: agent.driverKind,
    modelId: id,
    displayName,
    metadata,
  };
}
