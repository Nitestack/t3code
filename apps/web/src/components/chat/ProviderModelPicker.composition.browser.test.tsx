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

function Picker({
  keybindings = [],
  withAix = false,
}: {
  keybindings?: ResolvedKeybindingsConfig;
  withAix?: boolean;
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
  return (
    <>
      <output aria-label="Selected model">{model}</output>
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
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
            scope: "aix",
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
  await expect.element(page.getByRole("button", { name: "Model scope" })).not.toBeInTheDocument();
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

it("keeps scope controls available in non-composer pickers with aix profiles", async () => {
  await using _screen = await render(<Picker withAix />);
  await page.getByRole("button", { name: "Choose model" }).click();

  const scope = page.getByRole("button", { name: "Model scope" });
  await expect.element(scope).toHaveTextContent("Subscriptions");
  await scope.click();
  await page.getByRole("menuitemradio", { name: "aix" }).click();
  const profile = page.getByRole("button", { name: "aix profile" });
  await expect.element(profile).toHaveTextContent("adCare");
  await expect
    .element(page.getByRole("status", { name: "Selected model" }))
    .toHaveTextContent("original");
  profile.element().focus();
  await userEvent.tab({ shift: true });
  await expect.element(scope).toHaveFocus();
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

it("keeps the footer scope and profile controls keyboard reachable", async () => {
  await using _screen = await render(<FooterWithHierarchy />, { router: false }); // no routes involved
  await page.getByRole("button", { name: "Picker" }).click();
  const profile = page.getByRole("button", { name: "aix profile" });
  const scope = page.getByRole("button", { name: "Model scope" });
  await expect.element(profile).toHaveTextContent("adCare");
  profile.element().focus();
  await userEvent.tab({ shift: true });
  await expect.element(scope).toHaveFocus();
});
