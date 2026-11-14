import { ProviderDriverKind } from "@t3tools/contracts";

import { type CatalogModel, knownNonChatId } from "./ModelCatalog.ts";

/** Routes the caller has established from the profile endpoint and its configured API. */
export type AixModelRoute =
  | "anthropic-direct-messages"
  | "litellm-anthropic-messages"
  | "litellm-openai-responses"
  | "litellm-openai-chat";

/** `exact-live` and `limited-live` come from recorded T01 turns; everything else is unvalidated. */
export type AixRouteEvidence = "exact-live" | "limited-live" | "unvalidated";

export type AixUnroutableReason =
  | "invalid-model-id"
  | "non-chat-model"
  | "route-unknown"
  | "claude-direct-only"
  | "no-verified-agent"
  | "reasoning-override-unverified";

export type AixModelRouting =
  | {
      readonly kind: "routed";
      readonly driverKind: ProviderDriverKind;
      readonly modelId: string;
      readonly displayName: string;
      readonly metadata: Omit<CatalogModel, "id" | "displayName">;
      readonly evidence: AixRouteEvidence;
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

const LIVE_EVIDENCE: ReadonlyArray<{
  readonly id: string;
  readonly route: AixModelRoute;
  readonly evidence: AixRouteEvidence;
}> = [
  { id: "gpt-6.1-sol", route: "litellm-openai-responses", evidence: "exact-live" },
  { id: "claude-opus-5-5", route: "anthropic-direct-messages", evidence: "exact-live" },
  { id: "gpt-oss-120b", route: "litellm-openai-chat", evidence: "limited-live" },
  { id: "google/gemma-4-31b-it", route: "litellm-openai-chat", evidence: "limited-live" },
];

type AgentChoice =
  | { readonly driverKind: ProviderDriverKind }
  | { readonly reason: AixUnroutableReason };

function agentFor(id: string, routeKind: AixModelRoute, reasoningOverride: boolean): AgentChoice {
  const claudeFamily = id.startsWith("claude-");
  switch (routeKind) {
    case "anthropic-direct-messages":
      return claudeFamily && !id.includes("*")
        ? { driverKind: CLAUDE_CODE }
        : { reason: "claude-direct-only" };
    case "litellm-anthropic-messages":
      return claudeFamily ? { driverKind: CLAUDE_CODE } : { reason: "no-verified-agent" };
    case "litellm-openai-responses":
      if (id !== "gpt-6.1-sol") return { reason: "no-verified-agent" };
      return reasoningOverride
        ? { reason: "reasoning-override-unverified" }
        : { driverKind: CODEX };
    case "litellm-openai-chat":
      return { driverKind: OPENCODE };
    default:
      return { reason: "route-unknown" };
  }
}

/** Chooses a native agent only for a verified model/route pair; never retries or substitutes a model. */
export function routeCatalogModel(
  model: CatalogModel,
  input: { readonly route: AixModelRoute | undefined; readonly reasoningOverride?: boolean },
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

  const agent = agentFor(id, input.route, input.reasoningOverride === true);
  if ("reason" in agent) return unroutable(agent.reason);

  const evidence =
    LIVE_EVIDENCE.find((entry) => entry.id === id && entry.route === input.route)?.evidence ??
    "unvalidated";
  return {
    kind: "routed",
    driverKind: agent.driverKind,
    modelId: id,
    displayName,
    metadata,
    evidence,
  };
}
