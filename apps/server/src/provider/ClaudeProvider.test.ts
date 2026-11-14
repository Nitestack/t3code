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
