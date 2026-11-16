import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UsageScopeControl } from "./UsageScopeControl";

describe("UsageScopeControl", () => {
  it("switches between Personal and Work when both have data", async () => {
    let selected: "personal" | "work" = "personal";
    await using screen = await render(
      <UsageScopeControl
        groups={new Set(["personal", "work"])}
        scope={selected}
        onChange={(value) => {
          selected = value;
        }}
      />,
    );

    await expect.element(page.getByRole("group", { name: "Usage scope" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(selected).toBe("work");
  });

  it("hides the switch when only one scope has data", async () => {
    await using _screen = await render(
      <UsageScopeControl groups={new Set(["personal"])} scope="personal" onChange={() => {}} />,
    );

    await expect.element(page.getByRole("group", { name: "Usage scope" })).not.toBeInTheDocument();
  });

  it("switches scope from the compact header selector", async () => {
    let selected: "personal" | "work" = "personal";
    await using screen = await render(
      <UsageScopeControl
        groups={new Set(["personal", "work"])}
        scope={selected}
        compact
        onChange={(value) => {
          selected = value;
        }}
      />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Usage scope" }));
    await userEvent.click(screen.getByRole("option", { name: "Work" }));
    expect(selected).toBe("work");
  });
});
