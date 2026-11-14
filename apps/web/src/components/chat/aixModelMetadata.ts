import type { ServerProvider } from "@t3tools/contracts";

export function aixCatalogStatus(provider: ServerProvider): {
  readonly kind: "current" | "stale" | "unavailable";
  readonly message: string;
} | null {
  if (!provider.instanceId.startsWith("aix-")) return null;
  const message = provider.message?.trim();
  if (message?.toLowerCase().includes("aix catalog stale")) {
    return {
      kind: "stale",
      message,
    };
  }
  if (provider.status !== "ready") {
    return {
      kind: "unavailable",
      message: message || "The aix catalog is unavailable.",
    };
  }
  return {
    kind: "current",
    message: "Aix models are cached for up to 24 hours. Refresh to sync now.",
  };
}

export function catalogMetadataRows(
  metadata: ServerProvider["models"][number]["catalogMetadata"],
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const unknown = "Unknown";
  const price = (value: number | undefined) =>
    value === undefined ? unknown : `$${value} USD / 1M tokens`;
  const efforts = metadata?.reasoning?.efforts;
  return [
    { label: "Family", value: metadata?.family ?? unknown },
    {
      label: "Context window",
      value: metadata?.contextTokens === undefined ? unknown : `${metadata.contextTokens} tokens`,
    },
    {
      label: "Max output",
      value:
        metadata?.maxOutputTokens === undefined ? unknown : `${metadata.maxOutputTokens} tokens`,
    },
    { label: "Input", value: price(metadata?.pricing?.inputPerMillionTokens) },
    { label: "Output", value: price(metadata?.pricing?.outputPerMillionTokens) },
    { label: "Reasoning", value: efforts?.length ? efforts.join(", ") : unknown },
  ];
}
