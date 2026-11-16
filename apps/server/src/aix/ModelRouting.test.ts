import { expect, it } from "@effect/vitest";

import type { CatalogModel } from "./ModelCatalog.ts";
import * as ModelRouting from "./ModelRouting.ts";

const CHAT_ROUTES = [
  "anthropic-direct-messages",
  "litellm-anthropic-messages",
  "litellm-openai-responses",
  "litellm-openai-chat",
] as const satisfies ReadonlyArray<ModelRouting.AixModelRoute>;

const route = (id: string, routeKind: ModelRouting.AixModelRoute | undefined) =>
  ModelRouting.routeCatalogModel({ id, displayName: id }, { route: routeKind });

const outcome = (result: ModelRouting.AixModelRouting) =>
  result.kind === "routed" ? result.driverKind : `unroutable:${result.reason}`;

it("routes every catalog Claude model to Claude Code and every GPT Responses model to Codex", () => {
  expect(
    [
      route("claude-opus-5-5", "anthropic-direct-messages"),
      route("claude-sonnet-5-5", "anthropic-direct-messages"),
      route("anthropic/claude-opus-5-5", "anthropic-direct-messages"),
      route("claude-opus-5-5", "litellm-anthropic-messages"),
      route("claude-haiku-5-5", "litellm-anthropic-messages"),
    ].map(outcome),
  ).toEqual(Array(5).fill("claudeAgent"));
  expect(
    ["gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-sol-2026", "openai/GPT-6.1-sol"].map((id) =>
      outcome(route(id, "litellm-openai-responses")),
    ),
  ).toEqual(Array(4).fill("codex"));
  expect(outcome(route("claude-opus-5-5*", "litellm-anthropic-messages"))).toBe(
    "unroutable:no-native-agent",
  );
});

it("sends other chat models to OpenCode", () => {
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
    new Set(["opencode"]),
  );
});

it("keeps the native Anthropic profile Claude-only with no OpenCode or Codex fallback", () => {
  expect(
    ["gpt-6.1-sol", "google/gemma-4-31b-it", "claude-opus-5-5*"].map((id) =>
      outcome(route(id, "anthropic-direct-messages")),
    ),
  ).toEqual(Array(3).fill("unroutable:claude-direct-only"));
});

it("never maps GPT-OSS to Codex because of its gpt- prefix", () => {
  expect(outcome(route("gpt-oss-120b", "litellm-openai-responses"))).toBe(
    "unroutable:no-native-agent",
  );
  expect(outcome(route("gpt-oss-120b", "litellm-anthropic-messages"))).toBe(
    "unroutable:no-native-agent",
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

  expect(outcome(mislabeledGptOss)).toBe("unroutable:no-native-agent");
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
  });
});

it("rejects non-chat, generic wildcard, and empty IDs on every route", () => {
  const nonChatIds = [
    "text-embedding-3-large",
    "gpt-image-1.5",
    "gpt-realtime",
    "gpt-4o-realtime-preview",
    "openai/gpt-4o-mini-realtime-preview",
    "gpt-4o-audio-preview",
    "gpt-4o-mini-tts",
    "gpt-4o-transcribe",
    "a2a/assistant",
    "openai/*",
    "*",
  ];
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
