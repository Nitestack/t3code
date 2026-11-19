import type { AixCatalogModel } from "../provider/AixDiscovery.ts";

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ModelPricing {
  readonly inputPerMillionTokens?: number;
  readonly outputPerMillionTokens?: number;
  readonly cachedInputPerMillionTokens?: number;
  readonly cacheWritePerMillionTokens?: number;
}

export interface CatalogModel {
  /** The gateway's selectable ID. Keep it unchanged when formatting its display name. */
  readonly id: string;
  readonly displayName: string;
  /** Display-only family inferred from the model ID, not an API compatibility hint. */
  readonly family?: string;
  /** The upstream provider reported by the gateway; this does not imply an API protocol. */
  readonly provider?: string;
  readonly contextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly pricing?: ModelPricing;
  readonly reasoning?: {
    readonly efforts: readonly ReasoningEffort[];
    readonly defaultEffort?: ReasoningEffort;
  };
}

const CHAT_MODES = new Set(["chat", "responses"]);
const NON_MODEL_PROVIDERS = new Set(["a2a"]);

/** A model id without its provider prefix, lowercased: `Anthropic/Claude-X` is `claude-x`. */
export const modelName = (id: string): string => id.toLowerCase().split("/").at(-1) ?? "";

export function knownNonChatId(id: string): boolean {
  const lower = id.toLowerCase();
  const name = modelName(id);
  return (
    genericWildcard(lower) ||
    lower.startsWith("a2a/") ||
    name.startsWith("a2a-") ||
    name.startsWith("text-embedding-") ||
    name.startsWith("embedding-") ||
    name.startsWith("gpt-image-") ||
    name.includes("realtime") ||
    name.startsWith("gpt-audio") ||
    name.includes("-audio") ||
    name.startsWith("whisper-") ||
    name.startsWith("tts-") ||
    name.includes("-transcribe") ||
    name.includes("-tts") ||
    name.startsWith("dall-e-") ||
    name.startsWith("imagen-") ||
    name.startsWith("stable-diffusion-")
  );
}

const genericWildcard = (name: string) => name === "*" || name.endsWith("/*");

/** A listed model with whatever metadata aix knows; an ID-only listing has none. */
export type ListedModel = Pick<AixCatalogModel, "id"> & Partial<Omit<AixCatalogModel, "id">>;

const isEffort = (value: string | null | undefined): value is ReasoningEffort =>
  value != null && (REASONING_EFFORTS as readonly string[]).includes(value);

const positiveInteger = (value: number | null | undefined) =>
  value != null && Number.isInteger(value) && value > 0 ? value : undefined;

function pricingOf(pricing: ListedModel["pricing"]): ModelPricing | undefined {
  if (pricing == null) return undefined;
  const result = {
    ...(pricing.input_per_million != null && { inputPerMillionTokens: pricing.input_per_million }),
    ...(pricing.output_per_million != null && {
      outputPerMillionTokens: pricing.output_per_million,
    }),
    ...(pricing.cache_read_per_million != null && {
      cachedInputPerMillionTokens: pricing.cache_read_per_million,
    }),
    ...(pricing.cache_write_per_million != null && {
      cacheWritePerMillionTokens: pricing.cache_write_per_million,
    }),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function toModel(model: ListedModel): CatalogModel {
  const family = modelFamily(model.id);
  const contextTokens = positiveInteger(model.context_tokens);
  const maxOutputTokens = positiveInteger(model.max_output_tokens);
  const pricing = pricingOf(model.pricing);
  const efforts = REASONING_EFFORTS.filter((effort) => model.reasoning?.efforts.includes(effort));
  const defaultEffort = model.reasoning?.default_effort;
  const displayName = model.display_name?.trim();
  return {
    id: model.id,
    displayName: displayName || formatModelName(model.id),
    ...(family !== undefined && { family }),
    ...(model.provider != null && { provider: model.provider }),
    ...(contextTokens !== undefined && { contextTokens }),
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
    ...(pricing && { pricing }),
    ...(model.reasoning != null && {
      reasoning: {
        efforts,
        ...(isEffort(defaultEffort) && efforts.includes(defaultEffort) && { defaultEffort }),
      },
    }),
  };
}

/** Models that cannot be selected as a coding chat model are omitted. */
export function catalogModels(models: readonly ListedModel[]): CatalogModel[] {
  return models
    .filter(
      (model) =>
        !model.id.includes("*") &&
        !knownNonChatId(model.id) &&
        (model.provider == null || !NON_MODEL_PROVIDERS.has(model.provider)) &&
        (model.mode == null || CHAT_MODES.has(model.mode)),
    )
    .map(toModel)
    .sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName, "de", { numeric: true }) ||
        left.id.localeCompare(right.id),
    );
}

function modelFamily(id: string): string | undefined {
  const tokens = nameTokens(id).map((token) => token.toLowerCase());
  if (modelRegion(id) !== undefined) tokens.shift();
  const [first, second] = tokens;
  if (first === "gpt") return second === "oss" ? "GPT-OSS" : "GPT";
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
