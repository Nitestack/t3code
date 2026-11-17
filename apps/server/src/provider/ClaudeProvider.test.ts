import { ClaudeSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BUNDLED_CLAUDE_MODEL_CATALOG } from "./ClaudeModelCatalog.ts";
import { makePendingClaudeProvider } from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const syncedSettings = decodeClaudeSettings({
  customModels: [{ slug: "claude-synced", name: "Synced" }],
});
const bundledSlugs = BUNDLED_CLAUDE_MODEL_CATALOG.models.map((entry) => entry.model.slug);

it.effect("offers only the synced models on an aix-managed pending Claude instance", () =>
  Effect.gen(function* () {
    const managed = yield* makePendingClaudeProvider(
      syncedSettings,
      BUNDLED_CLAUDE_MODEL_CATALOG,
      true,
    );
    assert.deepStrictEqual(
      managed.models.map((model) => model.slug),
      ["claude-synced"],
    );

    const manual = yield* makePendingClaudeProvider(
      syncedSettings,
      BUNDLED_CLAUDE_MODEL_CATALOG,
      false,
    );
    assert.deepStrictEqual(
      manual.models.map((model) => model.slug),
      [...bundledSlugs, "claude-synced"],
    );
  }),
);

it.effect("removes Fast and Ultracode capabilities from synced aix Claude models", () =>
  Effect.gen(function* () {
    const builtIn = BUNDLED_CLAUDE_MODEL_CATALOG.models.find((entry) =>
      entry.model.capabilities?.optionDescriptors?.some(
        (descriptor) => descriptor.id === "ultracode" || descriptor.id === "fastMode",
      ),
    )?.model;
    assert.isDefined(builtIn);
    const settings = decodeClaudeSettings({
      customModels: [{ slug: builtIn.slug, name: "Synced" }],
    });
    const aix = yield* makePendingClaudeProvider(settings, BUNDLED_CLAUDE_MODEL_CATALOG, true);
    const manual = yield* makePendingClaudeProvider(settings, BUNDLED_CLAUDE_MODEL_CATALOG, false);
    const aixCapabilities = aix.models[0]?.capabilities?.optionDescriptors ?? [];
    const manualCapabilities =
      manual.models.find((model) => model.slug === builtIn.slug)?.capabilities?.optionDescriptors ??
      [];

    assert.isFalse(
      aixCapabilities.some(
        (descriptor) => descriptor.id === "ultracode" || descriptor.id === "fastMode",
      ),
    );
    assert.isTrue(manualCapabilities.some((descriptor) => descriptor.id === "ultracode"));
  }),
);
