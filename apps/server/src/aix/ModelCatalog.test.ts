import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ModelCatalog from "./ModelCatalog.ts";

const deployment = (
  model_name: string,
  model_info: Record<string, unknown> = {},
  model = `openai/${model_name}`,
) => ({ model_name, litellm_params: { model }, model_info });

const makeHttpClient = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request))),
  );

it("normalizes known model names while preserving exact selectable IDs", () => {
  const models = ModelCatalog.normalizeModelInfo(
    [
      deployment("gpt-6.1-sol", { litellm_provider: "openai", mode: "responses" }),
      deployment(
        "claude-opus-5-5*",
        { litellm_provider: "anthropic", mode: "chat" },
        "anthropic/claude-opus-5-5*",
      ),
      deployment(
        "google/gemma-4-31b-it",
        { litellm_provider: "vertex_ai", mode: "chat" },
        "vertex_ai/google/gemma-4-31b-it",
      ),
      deployment("gpt-oss-120b", { litellm_provider: "openai", mode: "chat" }),
    ],
    undefined,
    ["gpt-6.1-sol", "claude-opus-5-5*", "google/gemma-4-31b-it", "gpt-oss-120b"],
  );

  expect(models.map(({ id, displayName }) => [id, displayName])).toEqual([
    ["claude-opus-5-5*", "Claude Opus 5.5"],
    ["google/gemma-4-31b-it", "Gemma 4 31B IT"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-oss-120b", "GPT-OSS 120B"],
  ]);
  expect(models.find(({ id }) => id === "gpt-oss-120b")?.provider).toBe("openai");
  expect(models.map(({ id, family }) => [id, family])).toEqual([
    ["claude-opus-5-5*", "Claude"],
    ["google/gemma-4-31b-it", "Gemma"],
    ["gpt-6.1-sol", "OpenAI GPT"],
    ["gpt-oss-120b", "GPT-OSS"],
  ]);
});

it("filters non-chat and generic wildcard routes but keeps named wildcard aliases", () => {
  const models = ModelCatalog.normalizeModelInfo(
    [
      deployment("text-embedding-3-large", { mode: "embedding" }),
      deployment("gpt-image-1.5", { mode: "image" }),
      deployment("a2a/assistant", { litellm_provider: "a2a", mode: "chat" }),
      deployment("openai/*", { mode: "chat" }, "openai/*"),
      deployment("*", { mode: "chat" }, "openai/*"),
      deployment("claude-opus-5-5*", { mode: "chat" }, "anthropic/claude-opus-5-5*"),
      deployment("claude-sonnet-5-5*", { mode: "chat" }, "anthropic/another-model*"),
    ],
    undefined,
    [
      "text-embedding-3-large",
      "gpt-image-1.5",
      "a2a/assistant",
      "openai/*",
      "*",
      "claude-opus-5-5*",
      "claude-sonnet-5-5*",
    ],
  );

  expect(models.map(({ id }) => id)).toEqual(["claude-opus-5-5*"]);
});

it("filters known non-chat and generic wildcard IDs even when model info is missing", () => {
  const models = ModelCatalog.normalizeModelInfo([], undefined, [
    "text-embedding-3-large",
    "gpt-image-1.5",
    "a2a/assistant",
    "openai/*",
    "tenant/model*",
    "tenant/*/model",
    "tenant/Custom_Chat_Model",
  ]);

  expect(models.map(({ id }) => id)).toEqual(["tenant/Custom_Chat_Model"]);
});

it("includes listed custom IDs without metadata and leaves absent metadata unknown", () => {
  const models = ModelCatalog.normalizeModelInfo([], undefined, ["tenant/Model_Alias"]);

  expect(models).toEqual([{ id: "tenant/Model_Alias", displayName: "Model Alias" }]);
});

it("conservatively aggregates deployments and partial metadata", () => {
  const models = ModelCatalog.normalizeModelInfo([
    deployment("shared-model", {
      litellm_provider: "openai",
      mode: "chat",
      max_input_tokens: 160_000,
      max_output_tokens: 16_000,
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      reasoning_effort_levels: ["low", "high"],
    }),
    deployment("shared-model", {
      litellm_provider: "openai",
      mode: "chat",
      max_input_tokens: 128_000,
      max_output_tokens: 8_000,
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      reasoning_effort_levels: ["high", "xhigh"],
    }),
  ]);

  expect(models[0]).toMatchObject({
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
    pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 },
    reasoning: { efforts: ["high"] },
  });

  expect(
    ModelCatalog.normalizeModelInfo([
      deployment("mixed-mode-model", { mode: "chat" }),
      deployment("mixed-mode-model", { mode: "embedding" }),
    ]),
  ).toEqual([]);

  const incomplete = ModelCatalog.normalizeModelInfo([
    deployment("partial", { max_input_tokens: 128_000, input_cost_per_token: 0.000003 }),
    deployment("partial", { max_output_tokens: 8_000, input_cost_per_token: 0.000004 }),
    deployment("provider-conflict", { litellm_provider: "openai" }),
    deployment("provider-conflict", { litellm_provider: "anthropic" }),
  ])[0];
  expect(incomplete).not.toHaveProperty("contextTokens");
  expect(incomplete).not.toHaveProperty("pricing");
  expect(incomplete).not.toHaveProperty("reasoning");
  expect(
    ModelCatalog.normalizeModelInfo([
      deployment("provider-conflict", { litellm_provider: "openai" }),
      deployment("provider-conflict", { litellm_provider: "anthropic" }),
    ])[0],
  ).not.toHaveProperty("provider");

  for (const { info, efforts } of [
    { info: { supports_max_reasoning_effort: true }, efforts: ["max"] },
    { info: { supports_medium_reasoning_effort: true }, efforts: ["medium"] },
    { info: { supports_reasoning: true, supports_low_reasoning_effort: false }, efforts: [] },
  ]) {
    expect(
      ModelCatalog.normalizeModelInfo([deployment("sparse-reasoning", info)])[0]?.reasoning,
    ).toEqual({ efforts });
  }

  for (const names of [
    ["First", "Second"],
    ["Second", "First"],
  ]) {
    expect(
      ModelCatalog.normalizeModelInfo(
        names.map((display_name) => deployment("gpt-6.1-sol", { display_name })),
      )[0]?.displayName,
    ).toBe("GPT-6.1 Sol");
  }
});

it.effect("fetches every metadata page and derives sibling v2 and group endpoints", () =>
  Effect.gen(function* () {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const client = makeHttpClient((request) => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      const url = new URL(request.url);
      if (url.pathname.endsWith("/v1/models")) {
        return Response.json({
          data: [
            ...Array.from({ length: 101 }, (_, index) => ({ id: `model-${index}` })),
            { id: "tenant/Custom_Alias" },
          ],
        });
      }
      if (url.pathname.endsWith("/model_group/info")) {
        return Response.json({ data: [] });
      }
      const page = Number(url.searchParams.get("page"));
      const data =
        page === 1
          ? Array.from({ length: 100 }, (_, index) => deployment(`model-${index}`))
          : [deployment("model-100")];
      return Response.json({ data, ...(page === 2 ? { total_pages: 2 } : {}) });
    });
    const result = yield* ModelCatalog.fetchLiteLlmModelCatalog({
      baseURL: "https://gateway.example/proxy/v1",
      apiKey: "sentinel-api-key",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));

    expect(result.models).toHaveLength(102);
    expect(result.models.map(({ id }) => id)).toContain("tenant/Custom_Alias");
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/proxy/v1/models",
      "/proxy/v2/model/info",
      "/proxy/v2/model/info",
      "/proxy/model_group/info",
    ]);
    expect(requests.map(({ url }) => new URL(url).searchParams.get("page"))).toEqual([
      null,
      "1",
      "2",
      null,
    ]);
    expect(requests.every(({ authorization }) => authorization === "Bearer sentinel-api-key")).toBe(
      true,
    );
  }),
);

it.effect("fails closed on required endpoint failures without including the API key", () =>
  Effect.gen(function* () {
    const client = makeHttpClient(() =>
      Response.json({ error: "sentinel-api-key" }, { status: 503 }),
    );
    const result = yield* ModelCatalog.fetchLiteLlmModelCatalog({
      baseURL: "https://gateway.example/v1",
      apiKey: "sentinel-api-key",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result);

    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).not.toContain("sentinel-api-key");
  }),
);

it.effect("redacts a network failure from the required catalog request", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: new Error("sentinel-api-key network error"),
          }),
        }),
      ),
    );
    const result = yield* ModelCatalog.fetchLiteLlmModelCatalog({
      baseURL: "https://gateway.example/v1",
      apiKey: "sentinel-api-key",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result);

    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).not.toContain("sentinel-api-key");
  }),
);

it.effect("uses optional group metadata when available", () =>
  Effect.gen(function* () {
    const client = makeHttpClient((request) => {
      if (request.url.includes("/v1/models"))
        return Response.json({ data: [{ id: "custom-chat" }] });
      if (request.url.includes("/model_group/info")) {
        return Response.json({
          data: [{ model_group: "custom-chat", supported_reasoning_efforts: ["low", "high"] }],
        });
      }
      return Response.json({ data: [deployment("custom-chat", { mode: "chat" })], total_pages: 1 });
    });
    const result = yield* ModelCatalog.fetchLiteLlmModelCatalog({
      baseURL: "https://gateway.example/v1",
      apiKey: "sentinel-api-key",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));

    expect(result.models).toMatchObject([
      { id: "custom-chat", reasoning: { efforts: ["low", "high"] } },
    ]);
  }),
);

it.effect("keeps the catalog when optional group metadata fails", () =>
  Effect.gen(function* () {
    const client = makeHttpClient((request) => {
      if (request.url.includes("/v1/models"))
        return Response.json({ data: [{ id: "custom-chat" }] });
      if (request.url.includes("/model_group/info"))
        return Response.json({ error: "not supported" }, { status: 403 });
      return Response.json({
        data: [deployment("custom-chat", { reasoning_effort_levels: ["low"] })],
        total_pages: 1,
      });
    });
    const result = yield* ModelCatalog.fetchLiteLlmModelCatalog({
      baseURL: "https://gateway.example/v1",
      apiKey: "sentinel-api-key",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));

    expect(result.models).toMatchObject([{ id: "custom-chat", reasoning: { efforts: ["low"] } }]);
  }),
);

it.effect("rejects inconsistent page counts instead of returning a partial catalog", () =>
  Effect.gen(function* () {
    for (const { firstTotal, firstCount, finalTotal, finalCount } of [
      { firstTotal: 2, firstCount: 100, finalTotal: 1, finalCount: 0 },
      { firstTotal: undefined, firstCount: 100, finalTotal: 1, finalCount: 1 },
      { firstTotal: 2, firstCount: 100, finalTotal: 2, finalCount: 0 },
      { firstTotal: 3, firstCount: 100, finalTotal: 3, finalCount: 0 },
      ...["2", null, -1, 1.5].map((firstTotal) => ({
        firstTotal,
        firstCount: 1,
        finalTotal: 2,
        finalCount: 1,
      })),
    ]) {
      const client = makeHttpClient((request) => {
        if (request.url.includes("/v1/models")) {
          return Response.json({ data: [{ id: "model-0" }] });
        }
        const first = new URL(request.url).searchParams.get("page") === "1";
        const total = first ? firstTotal : finalTotal;
        return Response.json({
          data: Array.from({ length: first ? firstCount : finalCount }, (_, index) =>
            deployment(`model-${index}`),
          ),
          ...(total === undefined ? {} : { total_pages: total }),
        });
      });
      const result = yield* ModelCatalog.fetchLiteLlmModelCatalog({
        baseURL: "https://gateway.example/v1",
        apiKey: "sentinel-api-key",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result);

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "inconsistentPagination" },
      });
    }
  }),
);
