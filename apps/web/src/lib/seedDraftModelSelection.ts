import type { ModelSelection, ScopedProjectRef } from "@t3tools/contracts";
import {
  resolveDraftModelSelectionAfterUsageLimitFallback,
  resolveDraftModelSelectionForScope,
  resolveModelPickerProjectScope,
} from "@t3tools/client-runtime/provider-picker-hierarchy";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  draftDefaultProvidersFor,
  resolveProjectDefaultProviderModelSelection,
} from "../providerInstances";
import { readProject } from "../state/entities";
import { readEnvironment, readEnvironmentProviders } from "../state/environments";
import { hasExplicitComposerModelSelection } from "./chatThreadActions";

/** Gives a draft that moved project or machine the model a new thread there would start with. */
export function seedDraftModelSelection(draftId: DraftId, projectRef: ScopedProjectRef): void {
  const store = useComposerDraftStore.getState();
  if (hasExplicitComposerModelSelection(store.getComposerDraft(draftId))) return;
  const project = readProject(projectRef);
  const serverConfig = readEnvironment(projectRef.environmentId)?.serverConfig;
  const settings = serverConfig?.settings;
  const providers = readEnvironmentProviders(projectRef.environmentId) ?? [];
  const scoped = serverConfig?.environment?.capabilities?.projectScope === true;
  const scope = resolveModelPickerProjectScope(project?.scope, scoped);
  store.applyStickyState(draftId, scope);
  const normalDefault = settings
    ? (resolveProjectSettings(settings, projectRef.projectId, project ?? undefined).settings
        .defaultModelSelection ?? null)
    : (project?.defaultModelSelection ?? null);
  const fallbackFor = (defaultSelection: ModelSelection | null) =>
    resolveNewThreadModelSelection({
      defaultSelection,
      fallbackSelection: settings?.fallbackModelSelection ?? null,
      providers,
      ...(settings ? { settings } : {}),
      projectId: projectRef.projectId,
      now: Date.now(),
    });

  if (!scoped) {
    const resolution = fallbackFor(
      normalDefault ??
        (useComposerDraftStore.getState().stickyActiveProviderByScope[scope] !== null || !settings
          ? null
          : resolveProjectDefaultProviderModelSelection(providers, settings, projectRef.projectId)),
    );
    const selection = resolution.fallback ? resolution.selection : normalDefault;
    if (selection) store.setModelSelection(draftId, selection, { replaceOptions: true });
    return;
  }

  // Scope-aware environments drop a model from the other scope instead of carrying it over.
  const resolverProviders = settings
    ? draftDefaultProvidersFor(providers, settings, projectRef.projectId)
    : providers;
  const orderedDefault = settings
    ? resolveProjectDefaultProviderModelSelection(providers, settings, projectRef.projectId)
    : null;
  const sticky = useComposerDraftStore.getState();
  const stickyProvider = sticky.stickyActiveProviderByScope[scope];
  const stickySelection = stickyProvider
    ? (sticky.stickyModelSelectionByProvider[stickyProvider] ?? null)
    : null;
  const initialSelection = resolveDraftModelSelectionForScope({
    scope,
    normalDefault,
    orderedDefault,
    stickySelection,
    providers: resolverProviders,
  });
  const resolution = fallbackFor(initialSelection);
  const selection = resolution.fallback
    ? resolveDraftModelSelectionAfterUsageLimitFallback({
        scope,
        exhaustedSelection: initialSelection,
        fallbackSelection: resolution.selection,
        normalDefault,
        orderedDefault,
        stickySelection,
        providers: resolverProviders,
      })
    : initialSelection;
  if (selection) store.setModelSelection(draftId, selection, { replaceOptions: true });
  else store.setModelSelection(draftId, null);
}
