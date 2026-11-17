import type { ServerProvider } from "@t3tools/contracts";
import { formatContextWindowTokens } from "../../lib/contextWindow";

export function aixCatalogStatus(
  provider: ServerProvider,
  aixProfile = provider.aixProfile,
): {
  readonly kind: "current" | "warning" | "stale" | "unavailable";
  readonly message: string;
} | null {
  if (!aixProfile) return null;
  const message = provider.message?.trim();
  if (provider.status === "error") {
    return { kind: "unavailable", message: message || "The aix catalog is unavailable." };
  }
  if (provider.status === "warning" && message?.toLowerCase().includes("aix catalog stale")) {
    return {
      kind: "stale",
      message,
    };
  }
  if (provider.status === "warning") {
    return { kind: "warning", message: message || "The aix provider needs attention." };
  }
  return {
    kind: "current",
    message: message || "aix models are cached for up to 24 hours. Refresh to sync now.",
  };
}

export function catalogMetadataRows(
  metadata: ServerProvider["models"][number]["catalogMetadata"],
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const unknown = "Unknown";
  const price = (value: number | undefined) =>
    value === undefined ? unknown : `$${value} / 1M tokens`;
  const efforts = metadata?.reasoning?.efforts;
  return [
    { label: "Family", value: metadata?.family ?? unknown },
    {
      label: "Context window",
      value:
        metadata?.contextTokens === undefined
          ? unknown
          : `${formatContextWindowTokens(metadata.contextTokens)} tokens`,
    },
    {
      label: "Max output",
      value:
        metadata?.maxOutputTokens === undefined
          ? unknown
          : `${formatContextWindowTokens(metadata.maxOutputTokens)} tokens`,
    },
    { label: "Input", value: price(metadata?.pricing?.inputPerMillionTokens) },
    { label: "Output", value: price(metadata?.pricing?.outputPerMillionTokens) },
    { label: "Reasoning", value: efforts?.length ? efforts.join(", ") : unknown },
  ];
}
