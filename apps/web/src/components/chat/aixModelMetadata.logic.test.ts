import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { aixCatalogStatus, catalogMetadataRows } from "./aixModelMetadata";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("aix-codex-work"),
    driver: ProviderDriverKind.make("codex"),
    aixProfile: "work",
    aixProfileLabel: "Work",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("aix model picker metadata", () => {
  it("shows catalog status for older snapshots classified by the instance id", () => {
    expect(
      aixCatalogStatus(provider({ aixProfile: undefined, aixProfileLabel: undefined }), "work"),
    ).toMatchObject({ kind: "current" });
  });

  it("marks stale and unavailable aix catalogs and leaves T3 providers unchanged", () => {
    expect(
      aixCatalogStatus(
        provider({ status: "warning", message: "aix catalog stale since yesterday (request)." }),
      ),
    ).toEqual({
      kind: "stale",
      message: "aix catalog stale since yesterday (request).",
    });
    expect(aixCatalogStatus(provider({ status: "error" }))).toMatchObject({
      kind: "unavailable",
    });
    expect(
      aixCatalogStatus(
        provider({ instanceId: ProviderInstanceId.make("custom-codex"), aixProfile: undefined }),
      ),
    ).toBeNull();
  });

  it("prioritizes provider errors over stale notes and preserves unrelated warnings", () => {
    expect(
      aixCatalogStatus(
        provider({ status: "error", message: "Codex missing; aix catalog stale since yesterday" }),
      ),
    ).toMatchObject({ kind: "unavailable" });
    expect(
      aixCatalogStatus(provider({ status: "warning", message: "Codex needs attention" })),
    ).toEqual({
      kind: "warning",
      message: "Codex needs attention",
    });
  });

  it("shows Unknown for catalog fields the provider did not report", () => {
    expect(catalogMetadataRows(undefined)).toEqual([
      { label: "Family", value: "Unknown" },
      { label: "Context window", value: "Unknown" },
      { label: "Max output", value: "Unknown" },
      { label: "Input", value: "Unknown" },
      { label: "Output", value: "Unknown" },
      { label: "Reasoning", value: "Unknown" },
    ]);
  });

  it("shows supplied prices per million, family, context, output, and reasoning", () => {
    expect(
      catalogMetadataRows({
        family: "OpenAI GPT",
        contextTokens: 128_000,
        maxOutputTokens: 16_000,
        pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 8 },
        reasoning: { efforts: ["low", "high"] },
      }),
    ).toEqual([
      { label: "Family", value: "OpenAI GPT" },
      { label: "Context window", value: "128k tokens" },
      { label: "Max output", value: "16k tokens" },
      { label: "Input", value: "$2 USD / 1M tokens" },
      { label: "Output", value: "$8 USD / 1M tokens" },
      { label: "Reasoning", value: "low, high" },
    ]);
  });
});
