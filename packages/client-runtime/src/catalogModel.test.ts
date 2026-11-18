import { describe, expect, it } from "vite-plus/test";

import { isFreeCatalogModel } from "./catalogModel.ts";

describe("isFreeCatalogModel", () => {
  it("requires defined zero input and output prices", () => {
    expect(
      isFreeCatalogModel({
        pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 },
      }),
    ).toBe(true);
    expect(isFreeCatalogModel(undefined)).toBe(false);
    expect(isFreeCatalogModel({ pricing: { inputPerMillionTokens: 0 } })).toBe(false);
    expect(
      isFreeCatalogModel({
        pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0.01 },
      }),
    ).toBe(false);
  });
});
