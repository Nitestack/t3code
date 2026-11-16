import appCss from "../../index.css?inline";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { EnvironmentScopeSwitcher } from "./EnvironmentScopeSwitcher";

void appCss;

vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  return {
    ...actual,
    updateClientSettings: (patch: Partial<ReturnType<typeof actual.getClientSettings>>) =>
      actual.persistClientSettingsPatch(patch, async () => {}),
  };
});
describe("EnvironmentScopeSwitcher", () => {
  it("switches scope by keyboard without overflowing a narrow sidebar", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
    });
    const container = document.createElement("div");
    container.style.width = "216px";
    // This control only updates local preferences and performs no navigation.
    await using screen = await render(<EnvironmentScopeSwitcher />, { container, router: false });

    await userEvent.tab();
    await expect.element(screen.getByRole("button", { name: "Personal" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    const workButton = screen.getByRole("button", { name: "Work" });
    await expect.element(workButton).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(workButton).toHaveAttribute("aria-pressed", "true");

    const toggleGroup = screen.container.querySelector<HTMLElement>('[data-slot="toggle-group"]');
    expect(toggleGroup).not.toBeNull();
    expect(toggleGroup!.scrollWidth).toBeLessThanOrEqual(toggleGroup!.clientWidth);

    expect(getClientSettings().activeEnvironmentScope).toBe("work");
  });
});
