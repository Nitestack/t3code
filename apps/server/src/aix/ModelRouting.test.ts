import { expect, it } from "@effect/vitest";

import type { CatalogModel } from "./ModelCatalog.ts";
import * as ModelRouting from "./ModelRouting.ts";

const CHAT_ROUTES = [
  "anthropic-direct-messages",
  "litellm-anthropic-messages",
  "litellm-openai-responses",
  "litellm-openai-chat",
] as const satisfies ReadonlyArray<ModelRouting.AixModelRoute>;

const route = (
  id: string,
  routeKind: ModelRouting.AixModelRoute | undefined,
  options: { readonly reasoningOverride?: boolean } = {},
) => ModelRouting.routeCatalogModel({ id, displayName: id }, { route: routeKind, ...options });

const outcome = (result: ModelRouting.AixModelRouting) =>
  result.kind === "routed"
    ? `${result.driverKind}:${result.evidence}`
    : `unroutable:${result.reason}`;

it("routes only the exact live-probed model and route pairs to their native agent", () => {
  expect(outcome(route("gpt-6.1-sol", "litellm-openai-responses"))).toBe("codex:exact-live");
  expect(outcome(route("claude-opus-5-5", "anthropic-direct-messages"))).toBe(
    "claudeAgent:exact-live",
  );
  expect(outcome(route("gpt-oss-120b", "litellm-openai-chat"))).toBe("opencode:limited-live");
  expect(outcome(route("google/gemma-4-31b-it", "litellm-openai-chat"))).toBe(
    "opencode:limited-live",
  );
});

it("routes other Claude models to Claude Code as unvalidated candidates", () => {
  expect(outcome(route("claude-sonnet-5-5", "anthropic-direct-messages"))).toBe(
    "claudeAgent:unvalidated",
  );
  expect(outcome(route("claude-opus-5-5", "litellm-anthropic-messages"))).toBe(
    "claudeAgent:unvalidated",
  );
});

it("sends other chat models to OpenCode without claiming live validation", () => {
  const ids = [
    "tenant/Custom_Chat_Model",
    "gemini-3-pro",
    "deepseek-v4",
    "qwen3-coder",
    "devstral-2",
    "gpt-6.1-sol",
    "claude-opus-5-5",
  ];
  expect(new Set(ids.map((id) => outcome(route(id, "litellm-openai-chat"))))).toEqual(
    new Set(["opencode:unvalidated"]),
  );
});

it("keeps the native Anthropic profile Claude-only with no OpenCode or Codex fallback", () => {
  expect(
    ["gpt-6.1-sol", "google/gemma-4-31b-it", "anthropic/claude-opus-5-5", "claude-opus-5-5*"].map(
      (id) => outcome(route(id, "anthropic-direct-messages")),
    ),
  ).toEqual(Array(4).fill("unroutable:claude-direct-only"));
});

it("allows Codex only for the exact GPT-6.1 Sol Responses route without a reasoning override", () => {
  expect(
    outcome(route("gpt-6.1-sol", "litellm-openai-responses", { reasoningOverride: true })),
  ).toBe("unroutable:reasoning-override-unverified");
  expect(outcome(route("gpt-6.1-sol-2026", "litellm-openai-responses"))).toBe(
    "unroutable:no-verified-agent",
  );
  expect(outcome(route("openai/gpt-6.1-sol", "litellm-openai-responses"))).toBe(
    "unroutable:no-verified-agent",
  );
  expect(outcome(route("gpt-5", "litellm-openai-responses"))).toBe("unroutable:no-verified-agent");
  expect(outcome(route("gpt-6.1-sol", "litellm-anthropic-messages"))).toBe(
    "unroutable:no-verified-agent",
  );
  expect(outcome(route("gpt-6.1-sol", "litellm-openai-chat", { reasoningOverride: true }))).toBe(
    "opencode:unvalidated",
  );
});

it("never maps GPT-OSS to Codex because of its gpt- prefix", () => {
  expect(outcome(route("gpt-oss-120b", "litellm-openai-responses"))).toBe(
    "unroutable:no-verified-agent",
  );
  expect(outcome(route("gpt-oss-120b", "litellm-anthropic-messages"))).toBe(
    "unroutable:no-verified-agent",
  );
  expect(outcome(route("gpt-oss-120b", "anthropic-direct-messages"))).toBe(
    "unroutable:claude-direct-only",
  );
});

it("ignores display and family metadata when choosing a driver", () => {
  const mislabeledGptOss = ModelRouting.routeCatalogModel(
    { id: "gpt-oss-120b", displayName: "Claude Opus 5.5", family: "Claude", provider: "anthropic" },
    { route: "litellm-openai-responses" },
  );
  const gptOnDirectAnthropic = ModelRouting.routeCatalogModel(
    { id: "gpt-6.1-sol", displayName: "Claude Opus 5.5", family: "Claude", provider: "anthropic" },
    { route: "anthropic-direct-messages" },
  );

  expect(outcome(mislabeledGptOss)).toBe("unroutable:no-verified-agent");
  expect(outcome(gptOnDirectAnthropic)).toBe("unroutable:claude-direct-only");
});

it("passes the display name and catalog metadata through unchanged", () => {
  const catalog: CatalogModel = {
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    family: "OpenAI GPT",
    provider: "openai",
    contextTokens: 128_000,
    pricing: { inputPerMillionTokens: 2 },
  };

  expect(ModelRouting.routeCatalogModel(catalog, { route: "litellm-openai-responses" })).toEqual({
    kind: "routed",
    driverKind: "codex",
    modelId: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    metadata: {
      family: "OpenAI GPT",
      provider: "openai",
      contextTokens: 128_000,
      pricing: { inputPerMillionTokens: 2 },
    },
    evidence: "exact-live",
  });
});

it("rejects non-chat, generic wildcard, and empty IDs on every route", () => {
  const nonChatIds = ["text-embedding-3-large", "gpt-image-1.5", "a2a/assistant", "openai/*", "*"];
  expect(
    new Set(
      CHAT_ROUTES.flatMap((routeKind) => nonChatIds.map((id) => outcome(route(id, routeKind)))),
    ),
  ).toEqual(new Set(["unroutable:non-chat-model"]));
  expect(outcome(route("   ", "litellm-openai-chat"))).toBe("unroutable:invalid-model-id");
});

it("fails closed when the route is missing or not a known route", () => {
  expect(outcome(route("gpt-6.1-sol", undefined))).toBe("unroutable:route-unknown");
  expect(outcome(route("gpt-oss-120b", undefined))).toBe("unroutable:route-unknown");
  expect(
    outcome(route("gpt-6.1-sol", "litellm-openai-responses-v2" as ModelRouting.AixModelRoute)),
  ).toBe("unroutable:route-unknown");
});
