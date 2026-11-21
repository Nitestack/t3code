import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { UsageLimitsWork } from "./UsageLimitsWork";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });

  it("does not show probe failure notices in pooled or work usage limits", async () => {
    const timedOutWork: ServerProvider = {
      ...managedChatGpt("aix-opencode-adCare", "adCare"),
      aixProfile: "adCare",
      aixProfileLabel: "adCare",
      usageLimits: {
        checkedAt,
        profileName: "adCare",
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "The aix gateway budget request timed out.",
        },
      },
    };
    const failedPersonal: ServerProvider = {
      ...managedChatGpt("codex", "Codex"),
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Could not read limits." },
      },
    };
    const presentations = new Map([
      [
        EnvironmentId.make("wslstation"),
        {
          entry: { target: { label: "wslstation" } },
          serverConfig: { providers: [timedOutWork, failedPersonal] },
        },
      ],
    ]);

    await using workScreen = await render(
      <UsageLimitsWork presentations={presentations} now={Date.parse(checkedAt)} />,
    );
    await expect
      .element(workScreen.getByText(/The aix gateway budget request timed out/))
      .not.toBeInTheDocument();

    await using pooledScreen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );
    await expect.element(pooledScreen.getByText(/Could not read limits/)).not.toBeInTheDocument();
  });
});
