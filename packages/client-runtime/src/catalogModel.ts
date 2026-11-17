import type { CatalogModelMetadata } from "@t3tools/contracts";

export function isFreeCatalogModel(metadata: CatalogModelMetadata | null | undefined): boolean {
  const pricing = metadata?.pricing;
  return pricing?.inputPerMillionTokens === 0 && pricing.outputPerMillionTokens === 0;
}
