import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, ProjectId, RuntimeMode } from "@t3tools/contracts";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let projectRemoved = false;
  let connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
  let providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly driver: string;
    readonly enabled: boolean;
    readonly installed: boolean;
    readonly status: string;
    readonly models: ReadonlyArray<{ readonly slug: string; readonly isDefault?: boolean }>;
  }> = [];
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree" | null,
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null,
    fallbackModelSelection: null as { readonly instanceId: string; readonly model: string } | null,
    defaultRuntimeMode: "full-access" as RuntimeMode,
  };
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  let sourceComposer: {
    readonly activeProvider: string;
    readonly modelSelectionByProvider: Record<string, { instanceId: string; model: string }>;
    readonly modelSelectionExplicit?: boolean;
  } | null = null;
  let forceUsageFallback = false;
  let openDraftRoute: { readonly kind: "draft"; readonly draftId: string } | null = null;
  let sourceThreadRoute: { readonly kind: "server"; readonly threadRef: object } | null = null;
  let sourceThread: {
    readonly modelSelection: { readonly instanceId: string; readonly model: string };
    readonly latestRun: null;
    readonly itemCount: 0;
    readonly runtime: null;
  } | null = null;
  let draftsWithUserText = new Set<string>();
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn((draftId: string) => sourceComposer ?? { draftId }),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() =>
      openDraftRoute === null
        ? null
        : {
            logicalProjectKey: "remote-project",
            promotedTo: null,
            threadId: "thread-open",
            createdAt: "2026-01-01T00:00:00.000Z",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
    ),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    stickyActiveProviderByScope: { personal: null as string | null, work: null as string | null },
    stickyModelSelectionByProvider: {} as Record<string, { instanceId: string; model: string }>,
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
    setPrompt: vi.fn(),
  };

  return {
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get projectRemoved() {
      return projectRemoved;
    },
    get connectedEnvironmentIds() {
      return connectedEnvironmentIds;
    },
    disconnect(environmentId: string) {
      connectedEnvironmentIds = connectedEnvironmentIds.filter((id) => id !== environmentId);
    },
    removeProject() {
      projectRemoved = true;
    },
    hasUserText: (draft: { readonly draftId?: string } | null | undefined) =>
      draft?.draftId !== undefined && draftsWithUserText.has(draft.draftId),
    giveUserText(draftId: string) {
      draftsWithUserText = new Set([...draftsWithUserText, draftId]);
    },
    get openDraftRoute() {
      return openDraftRoute;
    },
    get routeTarget() {
      return sourceThreadRoute ?? openDraftRoute;
    },
    get sourceThread() {
      return sourceThread;
    },
    get forceUsageFallback() {
      return forceUsageFallback;
    },
    useUsageFallback() {
      forceUsageFallback = true;
    },
    setFallbackSelection(selection: { readonly instanceId: string; readonly model: string }) {
      targetSettings = { ...targetSettings, fallbackModelSelection: selection };
    },
    openServerThread(
      modelSelection: { readonly instanceId: string; readonly model: string },
      explicit = false,
    ) {
      sourceThreadRoute = { kind: "server", threadRef: {} };
      sourceThread = { modelSelection, latestRun: null, itemCount: 0, runtime: null };
      sourceComposer = {
        activeProvider: modelSelection.instanceId,
        modelSelectionByProvider: { [modelSelection.instanceId]: modelSelection },
        ...(explicit ? { modelSelectionExplicit: true } : {}),
      };
    },
    openEmptyDraft(draftId: string) {
      openDraftRoute = { kind: "draft", draftId };
    },
    get targetSettings() {
      return targetSettings;
    },
    get providers() {
      return providers;
    },
    set providers(value) {
      providers = value;
    },
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree" | null,
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
      openDraftRoute = null;
      sourceThreadRoute = null;
      sourceThread = null;
      sourceComposer = null;
      forceUsageFallback = false;
      draftsWithUserText = new Set();
      projectRemoved = false;
      connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
      providers = [];
      draftStore.stickyActiveProviderByScope = { personal: null, work: null };
      draftStore.stickyModelSelectionByProvider = {};
      targetSettings = {
        defaultThreadEnvMode: workspaceDefaults.envMode,
        newWorktreesStartFromOrigin: workspaceDefaults.startFromOrigin,
        defaultModelSelection: null,
        fallbackModelSelection: null,
        defaultRuntimeMode: "full-access",
      };
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setPrompt.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

const testServerConfigs = () =>
  new Map([
    [
      "environment-primary",
      {
        settings: {
          ...testState.targetSettings,
          newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
        },
        providers: testState.providers,
      },
    ],
    ["environment-ssh", { settings: testState.targetSettings, providers: testState.providers }],
  ]);

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "connected-environment-ids"
        ? testState.connectedEnvironmentIds
        : testServerConfigs(),
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : testServerConfigs(),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  filterByProjectScope: (
    values: ReadonlyArray<{ environmentId: string; projectId: string }>,
    scope: "personal" | "work",
    projects: ReadonlyArray<{ environmentId: string; id: string; scope?: "personal" | "work" }>,
  ) =>
    values.filter((value) =>
      projects.some(
        (project) =>
          project.environmentId === value.environmentId &&
          project.id === value.projectId &&
          (project.scope ?? "personal") === scope,
      ),
    ),
  filterProjectsByScope: (
    projects: ReadonlyArray<{ scope?: "personal" | "work" }>,
    scope: "personal" | "work",
  ) => projects.filter((project) => (project.scope ?? "personal") === scope),
  resolveProjectScope: (scope: unknown) => (scope === "work" ? "work" : "personal"),
  scopedProjectKey: (ref: { environmentId: string; projectId: string }) =>
    `${ref.environmentId}:${ref.projectId}`,
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({
  DEFAULT_RUNTIME_MODE: "default",
  DEFAULT_SERVER_SETTINGS: {},
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
  resolveProjectSettings: (
    settings: Record<string, unknown>,
    _projectId: unknown,
    _project: unknown,
    projectFile?: { defaultThreadEnvMode?: "local" | "worktree" } | null,
  ) => ({
    settings:
      projectFile === undefined
        ? settings
        : {
            ...settings,
            defaultThreadEnvMode:
              settings.defaultThreadEnvMode ?? projectFile?.defaultThreadEnvMode ?? "local",
          },
    sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
    overrides: {},
  }),
  resolveNewThreadEnvMode: (input: {
    projectSettings: { settings: { defaultThreadEnvMode: "local" | "worktree" } };
  }) => input.projectSettings.settings.defaultThreadEnvMode,
}));
vi.mock("@t3tools/shared/usageLimits", () => ({
  resolveNewThreadModelSelection: (input: {
    readonly defaultSelection: { readonly instanceId: string; readonly model: string } | null;
    readonly fallbackSelection: { readonly instanceId: string; readonly model: string } | null;
    readonly providers: ReadonlyArray<{ readonly instanceId: string }>;
  }) => {
    if (!testState.forceUsageFallback || !input.fallbackSelection) {
      return { selection: input.defaultSelection, fallback: null };
    }
    return {
      selection: input.fallbackSelection,
      fallback: {
        provider: input.providers.find(
          (provider) => provider.instanceId === input.defaultSelection?.instanceId,
        ),
        resetsAt: null,
      },
    };
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({
  orderItemsByPreferredIds: ({ items }: { items: unknown[] }) => items,
}));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: (draft: { readonly draftId?: string } | null | undefined) =>
      testState.hasUserText(draft),
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
  hasExplicitComposerModelSelection: (
    draft: { readonly modelSelectionExplicit?: boolean } | null,
  ) => draft?.modelSelectionExplicit === true,
}));
vi.mock("../providerInstances", () => ({
  draftDefaultProvidersFor: (entries: typeof testState.providers) => entries,
  resolveDefaultProviderModelSelection: () => null,
  resolveProjectDefaultProviderModelSelection: (entries: typeof testState.providers) => {
    const provider = entries.find(
      (entry) => !entry.instanceId.startsWith("aix-") && entry.enabled && entry.status === "ready",
    );
    const model = provider?.models.find((candidate) => candidate.isDefault) ?? provider?.models[0];
    return provider && model ? { instanceId: provider.instanceId, model: model.slug } : null;
  },
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => {
  const project = {
    id: "project-remote",
    environmentId: "environment-ssh",
    workspaceRoot: "/remote/project",
    defaultThreadEnvMode: null,
    defaultModelSelection: null,
  };
  return {
    readProject: () => (testState.projectRemoved ? null : project),
    readProjects: () => (testState.projectRemoved ? [] : [project]),
    readThreadShell: () => testState.sourceThread,
    readThreadShells: () => [],
    useProjects: () => [],
    useThread: () => null,
  };
});
vi.mock("../state/projects", () => ({ defaultProjectFallbackReadyAtom: () => true }));
vi.mock("../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("../state/presentation", () => ({
  environmentSummaries: { connectedEnvironmentIdsAtom: "connected-environment-ids" },
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () => testState.routeTarget,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ getClientSettings: () => ({}) }));

import { resolveDefaultProjectRef, useNewThreadHandler } from "./useHandleNewThread";

describe.each([
  ["new", null],
  [
    "reusable",
    {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    },
  ],
])("useNewThreadHandler with a %s draft", (_, draft) => {
  it("abandons a delayed draft open when the user navigates elsewhere", async () => {
    testState.reset(draft);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.router.state.location.href = "/usage";
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.router.state.location.href).toBe("/usage");
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });

  it("sets the prompt before the draft shows", async () => {
    testState.reset(draft);
    const pendingOpen = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;

    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      opened?.draftId,
      "Read the playbook. ",
    );
    expect(testState.draftStore.setPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      testState.router.navigate.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("abandons a delayed draft open when the project is removed meanwhile", async () => {
    testState.reset(draft);
    const pendingOpen = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.removeProject();
    testState.completeProjectFileRead(null);

    await expect(pendingOpen).resolves.toBeNull();
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });
});

describe("useNewThreadHandler", () => {
  it("clears a stale non-explicit model selection when no default resolves", async () => {
    testState.reset(null);

    const pending = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.completeProjectFileRead(null);
    await pending;

    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith("draft-delayed", null, {
      replaceOptions: true,
    });
  });

  it("does not carry an exhausted explicit source model into a new draft", async () => {
    testState.reset(null);
    testState.providers = [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "carried-model" }],
      },
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "fallback-model", isDefault: true }],
      },
    ];
    testState.setFallbackSelection({ instanceId: "codex", model: "fallback-model" });
    testState.useUsageFallback();
    testState.openServerThread({ instanceId: "claudeAgent", model: "carried-model" }, true);

    const pending = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.completeProjectFileRead(null);
    await pending;

    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      "draft-delayed",
      { instanceId: "codex", model: "fallback-model" },
      { replaceOptions: true },
    );
  });

  it("carries the current route model into a new draft when its scope matches", async () => {
    testState.reset(null);
    testState.providers = [
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "provider-default", isDefault: true }],
      },
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "carried-model" }],
      },
    ];
    testState.openServerThread({ instanceId: "claudeAgent", model: "carried-model" });

    const pending = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.completeProjectFileRead(null);
    await pending;

    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      "draft-delayed",
      { instanceId: "claudeAgent", model: "carried-model" },
      { replaceOptions: true },
    );
  });

  it("starts a personal draft on its ready subscription default when the global sticky is aix", async () => {
    testState.reset(null);
    testState.providers = [
      {
        instanceId: "aix-codex-team",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "work-default", isDefault: true }],
      },
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "personal-default", isDefault: true }],
      },
    ];
    testState.draftStore.stickyActiveProviderByScope = {
      personal: null,
      work: "aix-codex-team",
    };
    testState.draftStore.stickyModelSelectionByProvider = {
      "aix-codex-team": { instanceId: "aix-codex-team", model: "work-last" },
    };

    const pending = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.completeProjectFileRead(null);
    await pending;

    expect(testState.draftStore.applyStickyState).toHaveBeenCalledWith("draft-delayed", "personal");
    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      "draft-delayed",
      { instanceId: "codex", model: "personal-default" },
      { replaceOptions: true },
    );
  });

  it("prefers the scope's last-used model over the provider-order default", async () => {
    testState.reset(null);
    testState.providers = [
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "personal-default", isDefault: true }],
      },
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "claude-default", isDefault: true }, { slug: "claude-last" }],
      },
    ];
    testState.draftStore.stickyActiveProviderByScope = { personal: "claudeAgent", work: null };
    testState.draftStore.stickyModelSelectionByProvider = {
      claudeAgent: { instanceId: "claudeAgent", model: "claude-last" },
    };

    const pending = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.completeProjectFileRead(null);
    await pending;

    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      "draft-delayed",
      { instanceId: "claudeAgent", model: "claude-last" },
      { replaceOptions: true },
    );
  });

  it("keeps the text of a draft that gained some while it waited", async () => {
    testState.reset(null);
    const raced = {
      draftId: "draft-raced",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-raced",
    };
    testState.draftStore.getDraftSessionByLogicalProjectKey
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(raced as never);
    testState.giveUserText("draft-raced");

    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(opened?.draftId).toBe("draft-raced");
    expect(testState.draftStore.setPrompt).not.toHaveBeenCalled();
  });

  it("seeds the prompt into the empty draft that is already open", async () => {
    testState.reset(null);
    testState.openEmptyDraft("draft-open");

    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(opened?.draftId).toBe("draft-open");
    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      "draft-open",
      "Read the playbook. ",
    );
  });

  it("opens the draft without waiting on a project file from an offline machine", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: false });
    testState.disconnect("environment-ssh");

    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.router.navigate).toHaveBeenCalledOnce();
  });
});

describe("default project selection", () => {
  it("prefers the last used project in its environment and falls back when unavailable", () => {
    const projects = [
      { id: "project", environmentId: "first", workspaceRoot: "/first" },
      { id: "project", environmentId: "last-used", workspaceRoot: "/last-used" },
    ].map((project) => ({
      ...project,
      id: project.id as ProjectId,
      environmentId: project.environmentId as EnvironmentId,
      title: project.environmentId,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:00.000Z",
    }));
    expect(resolveDefaultProjectRef(projects, [], "last-used:project")).toEqual({
      environmentId: "last-used",
      projectId: "project",
    });
    expect(
      resolveDefaultProjectRef(projects.slice(0, 1), [], "last-used:project", false),
    ).toBeNull();
    expect(resolveDefaultProjectRef(projects.slice(0, 1), [], "last-used:project")).toEqual({
      environmentId: "first",
      projectId: "project",
    });
    expect(
      resolveDefaultProjectRef(
        [projects[0]!, { ...projects[1]!, archivedAt: "2026-11-09T00:00:00.000Z" }],
        [],
        "last-used:project",
      ),
    ).toEqual({ environmentId: "first", projectId: "project" });
  });
});
