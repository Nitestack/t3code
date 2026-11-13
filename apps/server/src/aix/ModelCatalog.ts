import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

const MODEL_INFO_PAGE_SIZE = 100;
const MODEL_INFO_MAX_PAGES = 100;

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelPricing {
  readonly inputPerMillionTokens?: number;
  readonly outputPerMillionTokens?: number;
  readonly cachedInputPerMillionTokens?: number;
}

export interface CatalogModel {
  /** LiteLLM's selectable ID. Keep it unchanged when formatting its display name. */
  readonly id: string;
  readonly displayName: string;
  /** Display-only family inferred from the model ID, not an API compatibility hint. */
  readonly family?: string;
  /** The upstream provider reported by LiteLLM; this does not imply an API protocol. */
  readonly provider?: string;
  readonly contextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly pricing?: ModelPricing;
  readonly reasoning?: {
    readonly efforts: readonly ReasoningEffort[];
    readonly defaultEffort?: ReasoningEffort;
  };
}

export type ModelCatalogFetchStage = "configuration" | "models" | "modelInfo" | "pagination";

export class ModelCatalogFetchError extends Schema.TaggedError<ModelCatalogFetchError>()(
  "ModelCatalogFetchError",
  {
    stage: Schema.Literals(["configuration", "models", "modelInfo", "pagination"]),
    reason: Schema.Literals([
      "configuration",
      "request",
      "status",
      "invalidResponse",
      "inconsistentPagination",
    ]),
    status: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    const location = this.stage === "models" ? "/v1/models" : "/v2/model/info";
    if (this.stage === "configuration") return "LiteLLM catalog base URL is invalid.";
    if (this.reason === "status") return `LiteLLM ${location} returned HTTP ${this.status}.`;
    if (this.reason === "inconsistentPagination")
      return `LiteLLM ${location} pagination is incomplete or inconsistent.`;
    if (this.reason === "invalidResponse")
      return `LiteLLM ${location} returned an invalid response.`;
    return `LiteLLM ${location} request failed.`;
  }
}

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeRecord = Schema.decodeUnknownOption(UnknownRecord);
const decodeString = Schema.decodeUnknownOption(Schema.String);
const decodeNumber = Schema.decodeUnknownOption(Schema.Number);
const decodeBoolean = Schema.decodeUnknownOption(Schema.Boolean);
const decodeStrings = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const decodeModelList = Schema.decodeUnknownOption(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);
const decodeModelInfoPage = Schema.decodeUnknownOption(
  Schema.Struct({ data: Schema.Array(Schema.Unknown) }),
);

const recordOf = (value: unknown): Record<string, unknown> =>
  Option.getOrElse(decodeRecord(value), () => ({}));

const stringAt = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = Option.getOrUndefined(decodeString(record[key]));
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const numberAt = (
  record: Record<string, unknown>,
  key: string,
  valid: (value: number) => boolean,
) => {
  const value = Option.getOrUndefined(decodeNumber(record[key]));
  return value !== undefined && Number.isFinite(value) && valid(value) ? value : undefined;
};

const booleanAt = (record: Record<string, unknown>, key: string) =>
  Option.getOrUndefined(decodeBoolean(record[key]));

const stringsAt = (record: Record<string, unknown>, key: string) =>
  Option.getOrUndefined(decodeStrings(record[key]));

const isPositiveInteger = (value: number) => Number.isInteger(value) && value > 0;
const isNonNegative = (value: number) => value >= 0;

const CHAT_MODES = new Set(["chat", "responses"]);
const NON_MODEL_PROVIDERS = new Set(["a2a"]);

function knownNonChatId(id: string): boolean {
  const lower = id.toLowerCase();
  const name = lower.split("/").at(-1) ?? lower;
  return (
    genericWildcard(lower) ||
    lower.startsWith("a2a/") ||
    name.startsWith("a2a-") ||
    name.startsWith("text-embedding-") ||
    name.startsWith("embedding-") ||
    name.startsWith("gpt-image-") ||
    name.startsWith("dall-e-") ||
    name.startsWith("imagen-") ||
    name.startsWith("stable-diffusion-")
  );
}

interface Deployment {
  readonly name: string;
  readonly params: Record<string, unknown>;
  readonly info: Record<string, unknown>;
}

function parseDeployment(value: unknown): Deployment | undefined {
  const record = Option.getOrUndefined(decodeRecord(value));
  if (!record) return undefined;
  const name = stringAt(record, "model_name");
  if (!name) return undefined;
  return {
    name,
    params: recordOf(record.litellm_params),
    info: recordOf(record.model_info),
  };
}

function providerOf({ params, info }: Deployment): string | undefined {
  const model = stringAt(params, "model");
  const routedProvider = model?.includes("/") ? model.split("/")[0] : undefined;
  return (
    stringAt(info, "litellm_provider") ??
    stringAt(params, "custom_llm_provider") ??
    routedProvider
  )?.toLowerCase();
}

const genericWildcard = (name: string) => name === "*" || name.endsWith("/*");

function unresolvedWildcard({ name, params }: Deployment): boolean {
  if (!name.includes("*")) return false;
  const model = stringAt(params, "model");
  const upstreamName = model?.split("/").at(-1);
  return (
    genericWildcard(name) || model === undefined || (model.includes("*") && upstreamName !== name)
  );
}

const asEffort = (value: string | undefined): value is ReasoningEffort =>
  value !== undefined && (REASONING_EFFORTS as readonly string[]).includes(value);

const effortsOf = (values: readonly string[]) =>
  REASONING_EFFORTS.filter((effort) => values.includes(effort));

function reasoningOf(info: Record<string, unknown>): CatalogModel["reasoning"] {
  if (booleanAt(info, "supports_reasoning") === false) return undefined;
  const explicit = stringsAt(info, "reasoning_effort_levels");
  const flags = {
    none: booleanAt(info, "supports_none_reasoning_effort"),
    minimal: booleanAt(info, "supports_minimal_reasoning_effort"),
    low: booleanAt(info, "supports_low_reasoning_effort"),
    medium: booleanAt(info, "supports_medium_reasoning_effort"),
    high: booleanAt(info, "supports_high_reasoning_effort"),
    xhigh: booleanAt(info, "supports_xhigh_reasoning_effort"),
    max: booleanAt(info, "supports_max_reasoning_effort"),
  };
  const hasFlag = Object.values(flags).some((value) => value !== undefined);
  if (explicit === undefined && !hasFlag) {
    return booleanAt(info, "supports_reasoning") === true ? { efforts: [] } : undefined;
  }
  const efforts =
    explicit !== undefined
      ? effortsOf(explicit)
      : REASONING_EFFORTS.filter((effort) => flags[effort] === true);
  const defaultEffort = stringAt(info, "default_reasoning_effort");
  return {
    efforts,
    ...(asEffort(defaultEffort) && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
  };
}

function agreed<T>(values: readonly (T | undefined)[]): T | undefined {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first) ? first : undefined;
}

function smallest(values: readonly (number | undefined)[]): number | undefined {
  return values.every((value) => value !== undefined)
    ? Math.min(...(values as readonly number[]))
    : undefined;
}

function perMillion(value: number): number | undefined {
  const converted = value * 1_000_000;
  if (!Number.isFinite(converted)) return undefined;
  const scaled = converted * 1_000_000;
  return Number.isFinite(scaled) ? Math.round(scaled) / 1_000_000 : converted;
}

function pricingOf(deployments: readonly Deployment[]): ModelPricing | undefined {
  const fields = [
    "input_cost_per_token",
    "output_cost_per_token",
    "cache_read_input_token_cost",
  ] as const;
  const converted = deployments.map((deployment) =>
    fields.map((field) => {
      const value = numberAt(deployment.info, field, isNonNegative);
      return value === undefined ? undefined : perMillion(value);
    }),
  );
  const allAgree = fields.every((_, index) =>
    converted.every((deployment) => deployment[index] === converted[0]?.[index]),
  );
  if (!allAgree) return undefined;
  const [inputPerMillionTokens, outputPerMillionTokens, cachedInputPerMillionTokens] =
    converted[0] ?? [];
  const pricing = {
    ...(inputPerMillionTokens !== undefined && { inputPerMillionTokens }),
    ...(outputPerMillionTokens !== undefined && { outputPerMillionTokens }),
    ...(cachedInputPerMillionTokens !== undefined && { cachedInputPerMillionTokens }),
  };
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

function reasoningOfAll(
  deployments: readonly Deployment[],
  groupEfforts: readonly string[] | undefined,
): CatalogModel["reasoning"] {
  const each = deployments.map(({ info }) => reasoningOf(info));
  const defaultEffort = agreed(
    deployments.map(({ info }) => stringAt(info, "default_reasoning_effort")),
  );
  if (groupEfforts !== undefined) {
    const efforts = effortsOf(groupEfforts);
    return efforts.length > 0 || each.some((reasoning) => reasoning !== undefined)
      ? {
          efforts,
          ...(asEffort(defaultEffort) && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
        }
      : undefined;
  }
  if (each.some((reasoning) => reasoning === undefined)) return undefined;
  const efforts = REASONING_EFFORTS.filter((effort) =>
    each.every((reasoning) => reasoning!.efforts.includes(effort)),
  );
  return {
    efforts,
    ...(asEffort(defaultEffort) && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
  };
}

function toModel(
  id: string,
  deployments: readonly Deployment[],
  groupEfforts: readonly string[] | undefined,
): CatalogModel {
  const infos = deployments.map(({ info }) => info);
  const pricing = pricingOf(deployments);
  const reasoning = reasoningOfAll(deployments, groupEfforts);
  const providers = deployments.map(providerOf);
  const contextTokens = smallest(
    infos.map((info) => numberAt(info, "max_input_tokens", isPositiveInteger)),
  );
  const maxOutputTokens = smallest(
    infos.map((info) => numberAt(info, "max_output_tokens", isPositiveInteger)),
  );
  const provider = agreed(providers);
  const family = modelFamily(id);
  return {
    id,
    displayName: agreed(infos.map((info) => stringAt(info, "display_name"))) ?? formatModelName(id),
    ...(family !== undefined && { family }),
    ...(provider !== undefined && { provider }),
    ...(contextTokens !== undefined && { contextTokens }),
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
    ...(pricing && { pricing }),
    ...(reasoning && { reasoning }),
  };
}

function modelFamily(id: string): string | undefined {
  const tokens = nameTokens(id).map((token) => token.toLowerCase());
  if (modelRegion(id) !== undefined) tokens.shift();
  const [first, second] = tokens;
  if (first === "gpt") return second === "oss" ? "GPT-OSS" : "OpenAI GPT";
  return first === undefined ? undefined : MODEL_FAMILIES.get(first);
}

const MODEL_FAMILIES = new Map([
  ["claude", "Claude"],
  ["gemma", "Gemma"],
  ["gemini", "Gemini"],
  ["llama", "Llama"],
  ["qwen", "Qwen"],
  ["deepseek", "DeepSeek"],
  ["mistral", "Mistral"],
  ["mixtral", "Mistral"],
  ["grok", "Grok"],
  ["phi", "Phi"],
  ["glm", "GLM"],
  ["command", "Cohere Command"],
  ["jamba", "Jamba"],
  ["minimax", "MiniMax"],
]);

/** Model names that cannot be selected as a coding chat model are omitted. */
export function normalizeModelInfo(
  entries: readonly unknown[],
  groups?: ReadonlyMap<string, readonly string[]>,
  modelIds?: readonly string[],
): CatalogModel[] {
  const byName = new Map<string, Deployment[]>();
  const knownNames = new Set<string>();
  const unresolved = new Set<string>();
  const nonChat = new Set<string>();

  for (const raw of entries) {
    const deployment = parseDeployment(raw);
    if (!deployment) continue;
    knownNames.add(deployment.name);
    if (unresolvedWildcard(deployment)) {
      unresolved.add(deployment.name);
      continue;
    }
    const provider = providerOf(deployment);
    const mode = stringAt(deployment.info, "mode")?.toLowerCase();
    if (
      knownNonChatId(deployment.name) ||
      (provider && NON_MODEL_PROVIDERS.has(provider)) ||
      (mode !== undefined && !CHAT_MODES.has(mode))
    ) {
      nonChat.add(deployment.name);
      continue;
    }
    const deployments = byName.get(deployment.name) ?? [];
    deployments.push(deployment);
    byName.set(deployment.name, deployments);
  }

  const listed = modelIds === undefined ? undefined : new Set(modelIds);
  for (const name of listed ?? []) {
    if (knownNonChatId(name) || name.includes("*")) continue;
    if (knownNames.has(name) || unresolved.has(name)) continue;
    byName.set(name, [{ name, params: {}, info: {} }]);
  }

  return [...byName.entries()]
    .filter(
      ([name]) =>
        !unresolved.has(name) && !nonChat.has(name) && (listed === undefined || listed.has(name)),
    )
    .map(([name, deployments]) => toModel(name, deployments, groups?.get(name)))
    .sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName, "de", { numeric: true }) ||
        left.id.localeCompare(right.id),
    );
}

/** Provider paths and deployment tags are removed for display; the selectable ID remains intact. */
function formatModelName(id: string): string {
  const tokens = nameTokens(id.replace(/([^/*])\*+$/, "$1"));
  if (modelRegion(id) !== undefined) tokens.shift();
  const parts = joinVersions(
    joinDates(tokens.filter((token) => !HOSTING_TAGS.has(token.toLowerCase()))),
  );
  if (parts.length === 0) return id;

  let name = "";
  for (let index = 0; index < parts.length; index += 1) {
    const previous = parts[index - 1];
    const part = parts[index]!;
    if (previous === undefined) name = word(part);
    else if (O_SERIES.test(previous)) name += `-${part}`;
    else if (previous.toLowerCase() === "gpt") name += `-${word(part)}`;
    else name += ` ${word(part)}`;
  }
  return name;
}

function modelRegion(id: string): string | undefined {
  const tokens = nameTokens(id);
  return tokens.length > 1 && /^[A-Z]{2}$/.test(tokens[0]!) ? tokens[0] : undefined;
}

const nameTokens = (id: string) => (id.split("/").at(-1) ?? id).split(/[-_\s]+/).filter(Boolean);
const HOSTING_TAGS = new Set(["sovereign"]);
const ACRONYMS = new Set(["gpt", "oss", "it", "vl", "glm", "moe", "ai"]);
const SPELLINGS: Record<string, string> = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  minimax: "MiniMax",
};
const O_SERIES = /^o\d+$/;
const SIZE = /^a?\d+(\.\d+)?[kmbt]$/i;

function word(part: string): string {
  if (SIZE.test(part)) return part.toUpperCase();
  if (/^\d/.test(part) || O_SERIES.test(part) || /[A-Z]/.test(part)) return part;
  const [, letters = part, rest = ""] = /^([a-z]+)(.*)$/.exec(part) ?? [];
  const spelled =
    SPELLINGS[letters] ??
    (ACRONYMS.has(letters)
      ? letters.toUpperCase()
      : letters.charAt(0).toUpperCase() + letters.slice(1));
  return spelled + rest;
}

function joinDates(tokens: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const [year, month, day] = tokens.slice(index, index + 3);
    if (/^\d{4}$/.test(year ?? "") && /^\d{2}$/.test(month ?? "") && /^\d{2}$/.test(day ?? "")) {
      result.push(`${year}-${month}-${day}`);
      index += 2;
    } else result.push(tokens[index]!);
  }
  return result;
}

function joinVersions(tokens: readonly string[]): string[] {
  const result: string[] = [];
  for (const token of tokens) {
    const previous = result.at(-1);
    if (previous !== undefined && /^\d{1,2}$/.test(previous) && /^\d{1,2}$/.test(token)) {
      result[result.length - 1] = `${previous}.${token}`;
    } else result.push(token);
  }
  return result;
}

export interface FetchLiteLlmModelCatalogInput {
  /** LiteLLM's API base URL ending in `/v1`, without credentials, query, or fragment. */
  readonly baseURL: string;
  readonly apiKey: string;
}

interface CatalogEndpoints {
  readonly models: string;
  readonly modelInfo: string;
  readonly modelGroupInfo: string;
}

function catalogEndpoints(baseURL: string): CatalogEndpoints | undefined {
  try {
    const base = new URL(baseURL);
    const path = base.pathname.replace(/\/+$/, "");
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !path.endsWith("/v1")
    )
      return undefined;
    const root = new URL(base.toString());
    root.pathname = path.slice(0, -3);
    root.search = "";
    root.hash = "";
    const api = new URL(base.toString());
    api.pathname = path;
    return {
      models: new URL(
        "models?return_wildcard_routes=true",
        `${api.toString().replace(/\/$/, "")}/`,
      ).toString(),
      modelInfo: new URL("v2/model/info", `${root.toString().replace(/\/$/, "")}/`).toString(),
      modelGroupInfo: new URL(
        "model_group/info",
        `${root.toString().replace(/\/$/, "")}/`,
      ).toString(),
    };
  } catch {
    return undefined;
  }
}

const fail = (
  stage: ModelCatalogFetchStage,
  reason: ModelCatalogFetchError["reason"],
  status?: number,
) => new ModelCatalogFetchError({ stage, reason, ...(status !== undefined && { status }) });

const requestJson = Effect.fn("AixModelCatalog.requestJson")(function* (
  url: string,
  apiKey: string,
  stage: Exclude<ModelCatalogFetchStage, "configuration" | "pagination">,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
        HttpClientRequest.setHeader("accept", "application/json"),
      ),
    )
    .pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(() => fail(stage, "request")),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* fail(stage, "status", response.status);
  }
  return yield* response.json.pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError(() => fail(stage, "invalidResponse")),
  );
});

const groupInfoSchema = Schema.Struct({ data: Schema.Array(Schema.Unknown) });
const decodeGroupInfo = Schema.decodeUnknownOption(groupInfoSchema);

function normalizeGroupEfforts(value: unknown): ReadonlyMap<string, readonly string[]> | undefined {
  const body = Option.getOrUndefined(decodeGroupInfo(value));
  if (!body) return undefined;
  const efforts = new Map<string, readonly string[]>();
  for (const raw of body.data) {
    const record = Option.getOrUndefined(decodeRecord(raw));
    if (!record) continue;
    const name = stringAt(record, "model_group");
    const values = stringsAt(record, "supported_reasoning_efforts");
    if (!name || !values) continue;
    const previous = efforts.get(name);
    efforts.set(
      name,
      previous === undefined ? values : previous.filter((effort) => values.includes(effort)),
    );
  }
  return efforts;
}

const readModelIds = Effect.fn("AixModelCatalog.readModelIds")(function* (
  url: string,
  apiKey: string,
) {
  const body = yield* requestJson(url, apiKey, "models");
  const parsed = Option.getOrUndefined(decodeModelList(body));
  if (!parsed || parsed.data.some(({ id }) => id.trim().length === 0)) {
    return yield* fail("models", "invalidResponse");
  }
  return parsed.data.map(({ id }) => id);
});

const readModelInfoPage = Effect.fn("AixModelCatalog.readModelInfoPage")(function* (
  url: string,
  apiKey: string,
  page: number,
) {
  const pageUrl = new URL(url);
  pageUrl.searchParams.set("page", String(page));
  pageUrl.searchParams.set("size", String(MODEL_INFO_PAGE_SIZE));
  const body = yield* requestJson(pageUrl.toString(), apiKey, "modelInfo");
  const parsed = Option.getOrUndefined(decodeModelInfoPage(body));
  if (!parsed) return yield* fail("modelInfo", "invalidResponse");
  const record = recordOf(body);
  const total = numberAt(record, "total_pages", (value) => Number.isInteger(value) && value >= 0);
  if (Object.hasOwn(record, "total_pages") && total === undefined) {
    return yield* fail("pagination", "inconsistentPagination");
  }
  return { data: parsed.data, totalPages: total };
});

/** Fetches the two required endpoints and optional group reasoning metadata without retaining the key. */
export const fetchLiteLlmModelCatalog = Effect.fn("AixModelCatalog.fetch")(function* ({
  baseURL,
  apiKey,
}: FetchLiteLlmModelCatalogInput) {
  const endpoints = catalogEndpoints(baseURL);
  if (!endpoints || apiKey.length === 0) return yield* fail("configuration", "configuration");
  const modelIds = yield* readModelIds(endpoints.models, apiKey);
  const groupsEffect = requestJson(endpoints.modelGroupInfo, apiKey, "modelInfo").pipe(
    Effect.map(normalizeGroupEfforts),
    Effect.orElseSucceed(() => undefined),
  );
  const entries: unknown[] = [];
  let expectedPages: number | undefined;
  for (let page = 1; page <= MODEL_INFO_MAX_PAGES; page += 1) {
    const result = yield* readModelInfoPage(endpoints.modelInfo, apiKey, page);
    if (result.totalPages !== undefined) {
      if (
        result.totalPages > MODEL_INFO_MAX_PAGES ||
        (result.totalPages < page && !(page === 1 && result.totalPages === 0)) ||
        (expectedPages !== undefined && expectedPages !== result.totalPages)
      ) {
        return yield* fail("pagination", "inconsistentPagination");
      }
      expectedPages = result.totalPages;
    }
    entries.push(...result.data);
    if (expectedPages !== undefined) {
      if (expectedPages === 0) {
        if (entries.length > 0) return yield* fail("pagination", "inconsistentPagination");
        break;
      }
      if (result.data.length === 0 && (page > 1 || expectedPages > 1)) {
        return yield* fail("pagination", "inconsistentPagination");
      }
      if (page >= expectedPages) break;
    } else if (result.data.length < MODEL_INFO_PAGE_SIZE) {
      break;
    }
    if (page === MODEL_INFO_MAX_PAGES) return yield* fail("pagination", "inconsistentPagination");
  }
  const groups = yield* groupsEffect;
  return { models: normalizeModelInfo(entries, groups, modelIds) };
});
