import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ComposerPickerFooter } from "./ComposerModelEffort";
import { runtimeModeConfig, runtimeModeOptions } from "./runtimeModeConfig";
import { ModelPickerHierarchyContext } from "./ModelPickerHierarchyContext";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useComposerMenuProps } from "./composerEventScope";

const instanceId = ProviderInstanceId.make("codex");
const aixInstanceId = ProviderInstanceId.make("aix-codex-ac");
const secondAixInstanceId = ProviderInstanceId.make("aix-codex-engineering");

function Picker({
  keybindings = [],
  withAix = false,
  withSecondAix = false,
  controlledOpen,
  projectScope = "personal",
}: {
  keybindings?: ResolvedKeybindingsConfig;
  withAix?: boolean;
  withSecondAix?: boolean;
  controlledOpen?: boolean;
  projectScope?: "personal" | "work";
}) {
  const [model, setModel] = useState("original");
  const modelOptionsByInstance = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "target", name: "Target model" },
      ],
    ],
  ]);
  if (withAix) {
    modelOptionsByInstance.set(aixInstanceId, [{ slug: "aix-only", name: "AIX model" }]);
  }
  if (withSecondAix) {
    modelOptionsByInstance.set(secondAixInstanceId, [
      { slug: "engineering-only", name: "Engineering model" },
    ]);
  }
  return (
    <>
      <output aria-label="Selected model">{model}</output>
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        projectScope={projectScope}
        {...(controlledOpen !== undefined ? { open: controlledOpen } : {})}
        model={model}
        lockedProvider={null}
        instanceEntries={deriveProviderInstanceEntries([
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
          ...(withAix
            ? [
                {
                  instanceId: aixInstanceId,
                  driver: ProviderDriverKind.make("codex"),
                  enabled: true,
                  installed: true,
                  version: null,
                  status: "ready" as const,
                  auth: { status: "authenticated" as const },
                  checkedAt: "2026-01-01T00:00:00.000Z",
                  models: [],
                  slashCommands: [],
                  skills: [],
                  aixProfile: "ac",
                  aixProfileLabel: "adCare",
                },
              ]
            : []),
          ...(withSecondAix
            ? [
                {
                  instanceId: secondAixInstanceId,
                  driver: ProviderDriverKind.make("codex"),
                  enabled: true,
                  installed: true,
                  version: null,
                  status: "ready" as const,
                  auth: { status: "authenticated" as const },
                  checkedAt: "2026-01-01T00:00:00.000Z",
                  models: [],
                  slashCommands: [],
                  skills: [],
                  aixProfile: "engineering",
                  aixProfileLabel: "Engineering",
                },
              ]
            : []),
        ])}
        keybindings={keybindings}
        modelOptionsByInstance={modelOptionsByInstance}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
      />
    </>
  );
}

function FooterWithHierarchy() {
  const [mode, setMode] = useState<"full-access">("full-access");
  const composerMenuProps = useComposerMenuProps();
  return (
    <Popover>
      <PopoverTrigger>Picker</PopoverTrigger>
      <PopoverPopup {...composerMenuProps}>
        <ModelPickerHierarchyContext.Provider
          value={{
            profiles: [{ id: "work", label: "adCare", entries: [] }],
            scope: "work",
            profileId: "work",
            onScopeChange: () => {},
            onProfileChange: () => {},
          }}
        >
          <ComposerPickerFooter
            traits={null}
            runtimeMode={mode}
            runtimeModeOptions={runtimeModeOptions.map((runtimeMode) => ({
              mode: runtimeMode,
              ...runtimeModeConfig[runtimeMode],
            }))}
            onRuntimeModeChange={() => setMode("full-access")}
            laneRows={null}
          />
        </ModelPickerHierarchyContext.Provider>
      </PopoverPopup>
    </Popover>
  );
}

it("keeps composition keys out of model selection and dismissal", async () => {
  await using screen = await render(<Picker />);
  await page.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect
    .element(page.getByRole("button", { name: "Work", exact: true }))
    .not.toBeInTheDocument();
  await search.fill("Target");
  await expect.element(page.getByRole("option", { name: /Target model/ })).toBeVisible();

  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ["Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        ...nativeEvent,
        bubbles: true,
        cancelable: true,
      });
      await act(() => search.element().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      await expect.element(search).toBeVisible();
      await expect
        .element(screen.getByRole("status", { name: "Selected model" }))
        .toHaveTextContent("original");
    }
  }

  await userEvent.keyboard("{Enter}");
  await expect.element(search).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("status", { name: "Selected model" }))
    .toHaveTextContent("target");
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect.element(search).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("moves ArrowLeft and Shift+Tab from search to the selected harness", async () => {
  await using _screen = await render(<Picker />);
  await page.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  const codex = page.getByRole("button", { name: "Codex" });

  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(codex).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(search).toHaveFocus();
  await userEvent.tab({ shift: true });
  await expect.element(codex).toHaveFocus();
});

it("shows the scope toggle and Work profile selector when scoped to Work", async () => {
  await using _screen = await render(<Picker withAix projectScope="work" />);
  await page.getByRole("button", { name: "Choose model" }).click();

  const profile = page.getByRole("button", { name: "Work profile: adCare" });
  await expect.element(profile).toHaveTextContent("adCare");
  await expect.element(page.getByRole("button", { name: "Personal", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Work", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Subscriptions" })).not.toBeInTheDocument();
});

it("switches the listed models with the picker scope", async () => {
  await using _screen = await render(<Picker withAix />);
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Target model/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /AIX model/ })).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect.element(page.getByRole("option", { name: /AIX model/ })).toBeVisible();
  await expect.element(page.getByRole("button", { name: /^Work profile/ })).toBeVisible();

  await page.getByRole("button", { name: "Personal", exact: true }).click();
  await expect.element(page.getByRole("option", { name: /Target model/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /AIX model/ })).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Work", exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Target model/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /AIX model/ })).not.toBeInTheDocument();
});

it("selects the matching harness when the Work profile changes", async () => {
  await using _screen = await render(<Picker withAix withSecondAix projectScope="work" />);
  await page.getByRole("button", { name: "Choose model" }).click();
  await page.getByRole("button", { name: "Work profile: adCare" }).click();
  await page.getByRole("menuitemradio", { name: "Engineering" }).click();
  await expect
    .element(page.getByRole("button", { name: "Work profile: Engineering" }))
    .toBeVisible();
  await expect.element(page.getByRole("option", { name: /Engineering model/ })).toBeVisible();
});

it("resets the Work profile before a controlled picker reopens", async () => {
  function ParentControlledPicker() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open picker
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Close picker
        </button>
        <Picker withAix withSecondAix controlledOpen={open} projectScope="work" />
      </>
    );
  }
  await using _screen = await render(<ParentControlledPicker />);
  await page.getByRole("button", { name: "Open picker" }).click();
  await page.getByRole("button", { name: "Work profile: adCare" }).click();
  await page.getByRole("menuitemradio", { name: "Engineering" }).click();
  await expect
    .element(page.getByRole("button", { name: "Work profile: Engineering" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Close picker" }).click();
  await expect.element(page.getByPlaceholder("Search models...")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Open picker" }).click();
  await expect.element(page.getByRole("button", { name: "Work profile: adCare" })).toBeVisible();
});

it("does not show a Work profile selector in Personal", async () => {
  await using _screen = await render(<Picker withAix projectScope="personal" />);
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("button", { name: /^Work profile/ })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("status", { name: "Selected model" }))
    .toHaveTextContent("original");
});

it("updates profile labels and model metadata when provider instances change", async () => {
  function LivePicker() {
    const [updated, setUpdated] = useState(false);
    const modelOptionsByInstance = new Map([
      [
        aixInstanceId,
        [
          {
            slug: "alpha",
            name: "Alpha",
            catalogMetadata: { contextTokens: updated ? 64000 : 128000 },
          },
        ],
      ],
    ]);
    const entry = deriveProviderInstanceEntries([
      {
        instanceId: aixInstanceId,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready" as const,
        auth: { status: "authenticated" as const },
        checkedAt: "2026-01-01T00:00:00.000Z",
        models: [
          {
            slug: "alpha",
            name: "Alpha",
            isCustom: false,
            capabilities: {},
            catalogMetadata: { contextTokens: updated ? 64000 : 128000 },
          },
        ],
        slashCommands: [],
        skills: [],
        aixProfile: "ac",
        aixProfileLabel: updated ? "Persönlich" : "adCare",
      },
    ]);
    return (
      <>
        <button onClick={() => setUpdated(true)}>Update providers</button>
        <ProviderModelPicker
          environmentId={null}
          projectScope="work"
          activeInstanceId={aixInstanceId}
          model="alpha"
          lockedProvider={null}
          instanceEntries={entry}
          modelOptionsByInstance={modelOptionsByInstance}
          triggerAriaLabel="Choose live model"
          onInstanceModelChange={() => {}}
        />
      </>
    );
  }

  await using _screen = await render(<LivePicker />);
  await page.getByRole("button", { name: "Choose live model" }).click();
  await expect
    .element(page.getByRole("button", { name: /^Work profile/ }))
    .toHaveTextContent("adCare");
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Update providers" }).click();
  await page.getByRole("button", { name: "Choose live model" }).click();
  await expect
    .element(page.getByRole("button", { name: /^Work profile/ }))
    .toHaveTextContent("Persönlich");
  await page.getByRole("button", { name: "Model details for Alpha" }).click();
  await expect.element(page.getByText("64k tokens")).toBeVisible();
});

it("keeps composing keys from triggering model jump shortcuts", async () => {
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "enter", command: "modelPicker.jump.1", when: "modelPickerOpen" },
  ]);
  await using screen = await render(<Picker keybindings={keybindings} />);
  await page.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await search.fill("Target");
  await expect.element(page.getByRole("option", { name: /Target model/ })).toBeVisible();

  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ...nativeEvent,
      bubbles: true,
      cancelable: true,
    });
    await act(() => search.element().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    await expect.element(search).toBeVisible();
    await expect
      .element(screen.getByRole("status", { name: "Selected model" }))
      .toHaveTextContent("original");
  }
});

it("keeps the scope toggle and Work profile selector keyboard reachable", async () => {
  await using _screen = await render(<FooterWithHierarchy />, { router: false }); // no routes involved
  await page.getByRole("button", { name: "Picker" }).click();
  const profile = page.getByRole("button", { name: "Work profile: adCare" });
  await expect.element(profile).toHaveTextContent("adCare");
  profile.element().focus();
  await userEvent.tab({ shift: true });
  await expect.element(page.getByRole("button", { name: "Personal", exact: true })).toHaveFocus();
  await userEvent.tab({ shift: true });
  await expect.element(page.getByRole("button", { name: "Picker" })).toHaveFocus();
});
