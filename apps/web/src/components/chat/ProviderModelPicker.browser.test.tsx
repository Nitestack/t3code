import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { toastManager } from "../ui/toast";

const aixState = vi.hoisted(() => ({
  allowed: false,
  refresh: vi.fn(),
  permission: undefined as unknown,
}));

vi.mock(import("@effect/atom-react"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomValue: ((atom: unknown) =>
      atom === aixState.permission
        ? aixState.allowed
        : actual.useAtomValue(atom as never)) as never,
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(false);
  aixState.permission = permission;
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      refreshProviders: {
        ...actual.serverEnvironment.refreshProviders,
        permissionAtom: (() => permission) as never,
      },
    },
  };
});
vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original()),
  useAtomCommand: (() => aixState.refresh) as never,
}));

it("keeps each registry image when adding a model from another ACP agent", async () => {
  const icons = [
    "https://cdn.agentclientprotocol.com/registry/icons/picker-explicit.svg",
    "https://cdn.agentclientprotocol.com/registry/v1/latest/picker-by-id.svg",
  ];
  const cache = await caches.open("t3-acp-registry-icons-v1");
  await using _cachedIcons = {
    async [Symbol.asyncDispose]() {
      await Promise.all(icons.map((url) => cache.delete(url)));
    },
  };
  for (const [index, url] of icons.entries()) {
    await cache.put(
      url,
      new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${11 + index * 6}" height="10"><path d="M0 0h10v10H0z"/></svg>`,
        { headers: { "content-type": "image/svg+xml" } },
      ),
    );
  }
  const entries = deriveProviderInstanceEntries(
    ["First", "Second"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: `${name} agent`,
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  ).map((entry, index) => ({
    ...entry,
    ...(index === 0 ? { acpRegistryIconUrl: icons[0] } : { acpRegistryAgentId: "picker-by-id" }),
  }));
  const first = { instanceId: entries[0]!.instanceId, model: "first" };
  const options = new Map(entries.map((entry) => [entry.instanceId, entry.models]));

  function Picker() {
    const [selection, setSelection] = useState<ReadonlyArray<ModelSelection>>([first]);
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={first.instanceId}
        model={first.model}
        {...(selection.length > 1 ? { selectedModels: selection } : {})}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        onToggleModel={(instanceId, model) => setSelection([...selection, { instanceId, model }])}
        onInstanceModelChange={(instanceId, model) => setSelection([{ instanceId, model }])}
      />
    );
  }

  await using screen = await render(<Picker />);
  const imageWidths = () =>
    Array.from(
      screen.container.querySelectorAll<HTMLImageElement>("[data-chat-provider-model-picker] img"),
      (image) => image.naturalWidth,
    );
  await vi.waitFor(() => expect(imageWidths()).toEqual([11]));
  await screen.getByRole("button", { name: "First model", exact: true }).click();
  await page.getByRole("button", { name: "Second agent", exact: true }).click();
  await userEvent.keyboard("{Shift>}");
  try {
    await page.getByRole("option", { name: /Second model/ }).click();
  } finally {
    await userEvent.keyboard("{/Shift}");
  }
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(imageWidths()).toEqual([11, 17]));
});

it("keeps a docked picker open after a pick and hands focus to that model's effort", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "second", name: "Second model" },
        { slug: "plain", name: "Plain model" },
      ],
    ],
  ]);
  // The last level is the selected one; "plain" has no effort to pick.
  const levels: Record<string, ReadonlyArray<string>> = {
    original: ["Low", "High"],
    second: ["Medium"],
    plain: [],
  };

  function Picker() {
    const [model, setModel] = useState("original");
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
        effortColumn={(levels[model] ?? []).map((level, index, all) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={index === all.length - 1}
            data-effort-row
            data-effort-level
          >
            {level}
          </button>
        ))}
      />
    );
  }

  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "High" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(search).toHaveFocus();

  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();

  await page.getByRole("option", { name: /Plain model/ }).click();
  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("opens on the active provider when every favorite belongs to a disabled provider", async () => {
  const entries = deriveProviderInstanceEntries(
    ["Codex", "Claude"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make(name.toLowerCase()),
      enabled: name === "Codex",
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  );
  const [codex, claude] = entries;
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    favorites: [{ provider: claude!.instanceId, model: "claude" }],
  });
  using _settings = {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Codex model/ })).toBeVisible();
});

it("starts in Favorites when a Personal favorite exists beside aix profiles", async () => {
  const entries = deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: "personal-model", name: "Personal model", isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    },
    {
      instanceId: ProviderInstanceId.make("aix-codex-work"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [{ slug: "work-model", name: "Work model", isCustom: false, capabilities: {} }],
      slashCommands: [],
      skills: [],
      aixProfile: "work",
      aixProfileLabel: "Work",
    },
  ]);
  const personal = entries.find((entry) => entry.instanceId === "codex")!;
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    favorites: [{ provider: personal.instanceId, model: "personal-model" }],
  });
  using _settings = {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      projectScope="personal"
      activeInstanceId={personal.instanceId}
      model="personal-model"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect
    .element(page.getByRole("button", { name: "Favorites" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(page.getByRole("option", { name: /Personal model/ })).toBeVisible();
});

const aixEnvironmentId = EnvironmentId.make("aix-test");
const aixInstanceId = ProviderInstanceId.make("aix-codex-work");
const aixEntries = deriveProviderInstanceEntries([
  {
    instanceId: aixInstanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "aix Codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      { slug: "alpha", name: "Alpha", isCustom: false, capabilities: {} },
      {
        slug: "vendor/beta-v2",
        name: "Beta",
        isCustom: false,
        capabilities: {},
        catalogMetadata: { contextTokens: 128000 },
      },
    ],
    slashCommands: [],
    skills: [],
  },
]);
const aixModelOptions = new Map([
  [
    aixInstanceId,
    [
      { slug: "alpha", name: "Alpha" },
      {
        slug: "vendor/beta-v2",
        name: "Beta",
        isLegacy: true,
        catalogMetadata: { contextTokens: 128000 },
      },
    ],
  ],
]);

function renderAixPicker(permission: boolean) {
  aixState.allowed = permission;
  function Picker() {
    const [model, setModel] = useState("alpha");
    return (
      <ProviderModelPicker
        environmentId={aixEnvironmentId}
        projectScope="work"
        activeInstanceId={aixInstanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={aixEntries}
        modelOptionsByInstance={aixModelOptions}
        triggerAriaLabel="Choose aix model"
        onInstanceModelChange={(_, nextModel) => setModel(nextModel)}
      />
    );
  }
  return render(<Picker />);
}

it("copies a non-selected aix model ID without selecting it", async () => {
  aixState.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
  using writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await using screen = await renderAixPicker(false);
  await screen.getByRole("button", { name: "Choose aix model" }).click();
  await page.getByRole("button", { name: "Model details for Beta" }).click();
  await page.getByRole("button", { name: "Copy model ID" }).click();
  await expect.element(page.getByRole("button", { name: "Model ID copied" })).toBeVisible();
  expect(writeText).toHaveBeenCalledWith("vendor/beta-v2");
  await expect
    .element(page.getByRole("button", { name: "Choose aix model" }))
    .toHaveTextContent("Alpha");
});

it("returns focus to search after closing model details so keyboard selection still works", async () => {
  await using screen = await renderAixPicker(false);
  await screen.getByRole("button", { name: "Choose aix model" }).click();
  const detailsButton = page.getByRole("button", { name: "Model details for Beta" });
  detailsButton.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Context window")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  const search = page.getByRole("combobox", { name: "Search models..." });
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect
    .element(page.getByRole("button", { name: "Choose aix model" }))
    .toHaveTextContent("Beta");
});

it("lets Escape close the picker when focus is on model details trigger", async () => {
  await using screen = await renderAixPicker(false);
  await screen.getByRole("button", { name: "Choose aix model" }).click();
  const detailsButton = page.getByRole("button", { name: "Model details for Beta" });
  detailsButton.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Context window")).toBeVisible();
  detailsButton.element().focus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("button", { name: "Choose aix model" })).toHaveFocus();
  await expect.element(page.getByText("Context window")).not.toBeInTheDocument();
});

it("hides aix catalog refresh without permission", async () => {
  await using screen = await renderAixPicker(false);
  await screen.getByRole("button", { name: "Choose aix model" }).click();
  await expect
    .element(page.getByRole("button", { name: "Refresh aix catalogs" }))
    .not.toBeInTheDocument();
});

it("disables aix catalog refresh while pending and surfaces a failed result", async () => {
  let finishRefresh!: (result: unknown) => void;
  aixState.refresh
    .mockReset()
    .mockImplementation(({ input }: { input: { refreshModels?: boolean } }) =>
      input.refreshModels
        ? new Promise((resolve) => (finishRefresh = resolve))
        : Promise.resolve({ _tag: "Success" }),
    );
  using toast = vi.spyOn(toastManager, "add");
  await using screen = await renderAixPicker(true);
  await screen.getByRole("button", { name: "Choose aix model" }).click();
  const refreshButton = page.getByRole("button", { name: "Refresh aix catalogs" });
  await expect.element(refreshButton).toBeVisible();
  refreshButton.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(refreshButton).toHaveAttribute("aria-disabled", "true");
  await expect.element(refreshButton).toHaveFocus();
  await act(async () =>
    finishRefresh(AsyncResult.failure(Cause.fail(new Error("refresh failed")))),
  );
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Could not refresh aix catalogs",
      }),
    ),
  );
  await expect.element(refreshButton).toBeEnabled();
});

it("keeps the touch keyboard down while choosing a provider", async () => {
  const entries = deriveProviderInstanceEntries(
    ["Codex", "Claude"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make(name.toLowerCase()),
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  );
  const [codex] = entries;
  const matchMedia = window.matchMedia.bind(window);
  using _touch = vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    query === "(pointer: coarse)"
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        } as MediaQueryList)
      : matchMedia(query),
  );

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  const popup = search.element().closest('[data-slot="popover-popup"]');
  await vi.waitFor(() => expect(document.activeElement).toBe(popup));

  await page.getByRole("button", { name: /^Claude/ }).click();
  await expect.element(page.getByRole("option", { name: /Claude model/ })).toBeVisible();
  await expect.element(search).not.toHaveFocus();
});
