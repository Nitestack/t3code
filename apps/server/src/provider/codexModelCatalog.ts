import type { ServerProviderModel, ServerProviderUpdateRequiredModel } from "@t3tools/contracts";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { codexModelFamily } from "@t3tools/shared/model";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "@t3tools/contracts";

const CODEX_MATCHING: ModelCatalog.CatalogMatching = { family: codexModelFamily };

const CodexModelAdapter = Schema.Struct({
  codex: Schema.optional(Schema.Struct({ minVersion: Schema.optional(TrimmedNonEmptyString) })),
});
const decodeCodexModelAdapter = Schema.decodeUnknownOption(CodexModelAdapter);

export function withoutAixCodexModelOptions(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    const descriptors = model.capabilities?.optionDescriptors;
    if (!descriptors) return model;
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: descriptors.filter(
          (descriptor) =>
            descriptor.id !== "fastMode" &&
            descriptor.id !== "ultracode" &&
            descriptor.id !== "serviceTier",
        ),
      },
    };
  });
}

/** Codex catalogs omit models released after the installed CLI. */
function codexUpdateRequiredModels(
  catalog: ModelCatalog.ProviderCatalog | undefined,
  draft: ServerProviderDraft,
): ReadonlyArray<ServerProviderUpdateRequiredModel> {
  const version = draft.version?.replace(/^v/, "");
  if (!catalog || !version || parseSemver(version) === null) return [];
  const discovered = new Set(draft.models.map((model) => codexModelFamily(model.slug)));
  return catalog.models.flatMap((entry) => {
    if (entry.status !== "current" || discovered.has(codexModelFamily(entry.slug))) return [];
    const minVersion = Option.getOrUndefined(decodeCodexModelAdapter(entry.adapter ?? {}))?.codex
      ?.minVersion;
    if (!minVersion || parseSemver(minVersion) === null) return [];
    if (compareSemverVersions(version, minVersion) >= 0) return [];
    return [
      {
        slug: entry.slug,
        name: entry.name,
        ...(entry.badge ? { badge: entry.badge } : {}),
        minVersion,
      },
    ];
  });
}

/** An aix-managed instance offers only synced models, and discovery already excludes their families. */
export function applyCodexModelCatalog(
  draft: ServerProviderDraft,
  catalog: ModelCatalog.ProviderCatalog | undefined,
  aixManaged = false,
): ServerProviderDraft {
  const updateRequiredModels = aixManaged ? [] : codexUpdateRequiredModels(catalog, draft);
  const classified = ModelCatalog.applyModelCatalog(draft, catalog, CODEX_MATCHING);
  return {
    ...(aixManaged
      ? { ...classified, models: withoutAixCodexModelOptions(classified.models) }
      : classified),
    ...(updateRequiredModels.length > 0 ? { updateRequiredModels } : {}),
  };
}
