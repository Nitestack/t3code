import appCss from "../../index.css?inline";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import { useEnvironmentIdentities } from "../../state/environments";
import { EnvironmentScopeSwitcher } from "./EnvironmentScopeSwitcher";

void appCss;

vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  return {
    ...actual,
    updateClientSettings: async (patch: Partial<ReturnType<typeof actual.getClientSettings>>) => {
      actual.__setClientSettingsForTests({ ...actual.getClientSettings(), ...patch });
    },
  };
});
vi.mock("../../state/environments", { spy: true });

describe("EnvironmentScopeSwitcher", () => {
  it("switches scope by keyboard and classifies an environment without overflowing a narrow sidebar", async () => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      environmentScopeAssignments: {},
    });
    const environmentId = EnvironmentId.make("work-server");
    vi.mocked(useEnvironmentIdentities).mockReturnValue([
      { environmentId, label: "Work server" },
    ] as never);

    const container = document.createElement("div");
    container.style.width = "216px";
    // This control only updates local preferences and performs no navigation.
    await using screen = await render(<EnvironmentScopeSwitcher />, { container, router: false });

    await userEvent.tab();
    const workButton = screen.getByRole("button", { name: "Work" });
    await expect.element(workButton).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(workButton).toHaveAttribute("aria-pressed", "true");

    const toggleGroup = screen.container.querySelector<HTMLElement>('[data-slot="toggle-group"]');
    expect(toggleGroup).not.toBeNull();
    expect(toggleGroup!.scrollWidth).toBeLessThanOrEqual(toggleGroup!.clientWidth);

    await userEvent.click(screen.getByRole("button", { name: "Classify environments" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Work server" }));
    expect(getClientSettings().environmentScopeAssignments[environmentId]).toBe("work");
  });
});
