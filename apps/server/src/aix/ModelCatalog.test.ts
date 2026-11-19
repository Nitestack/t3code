import { expect, it } from "vite-plus/test";

import * as ModelCatalog from "./ModelCatalog.ts";

it("names and orders aix models and keeps the selectable ID", () => {
  const models = ModelCatalog.catalogModels([
    { id: "gpt-6.1-sol", mode: "responses", provider: "openai" },
    { id: "claude-opus-5-5", mode: "chat", provider: "anthropic" },
    { id: "google/gemma-4-31b-it", mode: "chat", provider: "vertex_ai" },
    { id: "gpt-oss-120b", mode: "chat", display_name: "  " },
    { id: "tenant/Model_Alias" },
  ]);

  expect(models.map(({ id, displayName, family }) => [id, displayName, family])).toEqual([
    ["claude-opus-5-5", "Claude Opus 5.5", "Claude"],
    ["google/gemma-4-31b-it", "Gemma 4 31B IT", "Gemma"],
    ["gpt-6.1-sol", "GPT-6.1 Sol", "GPT"],
    ["gpt-oss-120b", "GPT-OSS 120B", "GPT-OSS"],
    ["tenant/Model_Alias", "Model Alias", undefined],
  ]);
  expect(models.at(-1)).toEqual({ id: "tenant/Model_Alias", displayName: "Model Alias" });
  expect(ModelCatalog.catalogModels([{ id: "x-1", display_name: "Named" }])[0]?.displayName).toBe(
    "Named",
  );
});

it("omits models that cannot be selected for chat", () => {
  const models = ModelCatalog.catalogModels([
    { id: "text-embedding-3-large" },
    { id: "gpt-image-1.5" },
    { id: "a2a/assistant" },
    { id: "tenant/model*" },
    { id: "agent-model", provider: "a2a" },
    { id: "e5-mistral-7b-instruct", mode: "embedding" },
    { id: "tenant/Custom_Chat_Model", mode: null },
  ]);

  expect(models.map(({ id }) => id)).toEqual(["tenant/Custom_Chat_Model"]);
});

it("maps limits, pricing and reasoning, dropping values T3 cannot use", () => {
  const [model] = ModelCatalog.catalogModels([
    {
      id: "shared-model",
      mode: "chat",
      context_tokens: 128_000,
      max_output_tokens: 8_000,
      pricing: {
        input_per_million: 3,
        output_per_million: 15,
        cache_read_per_million: null,
        cache_write_per_million: 3.75,
      },
      reasoning: { efforts: ["high", "turbo", "low"], default_effort: "high" },
    },
  ]);
  expect(model).toMatchObject({
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
    pricing: {
      inputPerMillionTokens: 3,
      outputPerMillionTokens: 15,
      cacheWritePerMillionTokens: 3.75,
    },
    reasoning: { efforts: ["low", "high"], defaultEffort: "high" },
  });
  expect(model?.pricing).not.toHaveProperty("cachedInputPerMillionTokens");

  const [sparse] = ModelCatalog.catalogModels([
    {
      id: "sparse",
      context_tokens: 0,
      pricing: {
        input_per_million: null,
        output_per_million: null,
        cache_read_per_million: null,
        cache_write_per_million: null,
      },
      reasoning: { efforts: [], default_effort: "max" },
    },
  ]);
  expect(sparse).not.toHaveProperty("contextTokens");
  expect(sparse).not.toHaveProperty("pricing");
  expect(sparse?.reasoning).toEqual({ efforts: [] });
});
