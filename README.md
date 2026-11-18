# T3 Code with aix support

A soft fork of [T3 Code](https://github.com/pingdotgg/t3code), created by pingdotgg and released under the [MIT License](./LICENSE). It keeps T3's provider, thread, and remote-work flows, and adds runtime support for [aix](https://github.com/Nitestack/aix) API-key profiles and project-level Personal and Work scopes.

[Upstream T3 Code](https://github.com/pingdotgg/t3code) · [aix setup and profiles](https://github.com/Nitestack/aix#installation) · [Fork guide](./docs/user/nitestack-fork.md) · [Remote access](./docs/user/remote-access.md) · [Portable handoffs](./docs/user/portable-handoffs.md) · [MIT License](./LICENSE)

## What the fork adds

- **aix profiles as providers.** Enable with `T3CODE_AIX=1` on the server host. Each API-key profile becomes a provider instance with its own gateway endpoint. Keys stay on the server.
- **Conservative model routing.** Supported models are mapped to Codex, Claude Code, or the T3-managed OpenCode provider according to known-compatible routes. Unsupported combinations are omitted; a failed selection is not silently replaced with another provider or model.
- **Model and gateway details.** When aix or the gateway supplies them, model details include family, context and output limits, prices, and reasoning levels. Missing values appear as Unknown. A profile's LiteLLM budget is shown on the Usage page when the gateway reports a cap; a reset time appears when supplied.
- **Catalog refresh.** Refresh aix profiles and catalogs on demand; a failed refresh keeps the last catalog marked stale.
- **Personal and Work scopes.** Each project is Personal or Work. On web, desktop, and the fork's Android app, the sidebar switch shows one scope's projects and threads, and the model picker starts in the project's scope: subscription providers for Personal, aix profiles for Work.

T3's existing providers, threads, provider switching and handoffs, and remote access remain available. Without `T3CODE_AIX=1`, aix integration is off and normal T3 providers work as usual.

## In the app

Captured from the fork's web client with demo projects, demo profiles (Acme and Research), and a local fake gateway. Prices, budgets, and names are illustrative.

### aix profiles and model details

In a Work project, the picker lists the selected profile's Codex, Claude Code, and OpenCode models. Model details show the context window, output limit, and pricing supplied by the gateway.

![aix model picker in a Work project showing Gemma 4 31B IT and demo gateway metadata](./.github/readme/aix/aix-model-picker.png)

Switch profiles from the picker footer.

![Model picker footer with the Acme and Research profile menu open](./.github/readme/aix/aix-profile-menu.png)

In Settings → Providers, the Personal/Work switch and profile menu list each profile's provider instances. aix supplies the models; you can still hide, reorder, and favorite them.

![Provider settings showing the Research profile's OpenCode instance and its aix models](./.github/readme/aix/aix-provider-settings.png)

### Gateway budgets

The Usage page's Work tab shows the budget reported for each profile, including a reset time when the gateway supplies one.

![Usage page Work tab with demo budgets for the Acme and Research profiles](./.github/readme/aix/aix-budget-windows.png)

### Personal and Work scopes

Move a project between Personal and Work from its sidebar menu, the command palette, or Project settings; the sidebar switch then filters projects and threads. The scope does not change server permissions or stop running agents.

![Project settings listing demo projects with their Personal and Work scopes](./.github/readme/aix/work-personal-scope.png)

## Install

Download the fork from its [latest release](https://github.com/Nitestack/t3code/releases/latest). It uses the same app name and data directory as upstream T3 Code, so install it **instead of** upstream T3 Code. Installed desktop apps update themselves from later fork releases.

### Windows (x64)

Download `T3-Code-<version>-x64.exe` and run it. The installer is not code-signed, so Windows may show "Windows protected your PC": choose **More info → Run anyway**.

### macOS (Apple Silicon)

Install with the script. It is the only supported way: the app is not notarized by Apple, so Gatekeeper blocks a DMG or zip downloaded in a browser.

```sh
curl -fsSL https://github.com/Nitestack/t3code/releases/latest/download/install-macos.sh | bash
```

The script checks the download's SHA-256, installs **T3 Code** into `/Applications` (or `~/Applications`), and opens it.

### Linux (x64)

Download `T3-Code-x86_64.AppImage`, then make it executable and start it:

```sh
chmod +x ./T3-Code-x86_64.AppImage
./T3-Code-x86_64.AppImage
```

On Debian or Ubuntu you can install `T3-Code-<version>-amd64.deb` instead, with
`sudo apt install ./T3-Code-<version>-amd64.deb`. Both update themselves.

On NixOS, or to manage T3 with Nix, install the fork's flake instead; Nix handles updates:

```sh
nix profile add 'github:Nitestack/t3code/release'
```

See the [fork Nix guide](./docs/user/install.md#t3-code-fork-nix) for NixOS and Home Manager.

### Android

Download `T3-Code-<version>.apk` and open it on your phone. It replaces the Play Store T3 Code app, so uninstall that first. Install later APKs from fork releases the same way.

### Set up aix

T3 runs agents through [aix](https://github.com/Nitestack/aix) profiles on the **machine running the T3 server**, which is your computer when you use the desktop app (inside WSL if the Windows app runs its server there). Install aix there:

```sh
curl -fsSL https://github.com/Nitestack/aix/releases/latest/download/install.sh | sh
```

Configure an API-key profile with aix's [profile guide](https://github.com/Nitestack/aix#config-format) and check it with `aix profiles`. ChatGPT sign-in profiles are not supported. The fork's desktop app and Nix package turn aix on for you; set `T3CODE_AIX=0` to turn it off. Restart T3 after installing aix so it finds the command.

To host T3 for other devices without the desktop app, run `t3 serve`; it prints pairing details. See [remote access](./docs/user/remote-access.md). To work on the fork itself, see the [development runbook](./docs/operations/development.md#first-checkout).

## A typical workflow

Select an aix profile's model from the thread model picker. The profile and model determine the gateway endpoint and supported agent route. Open model details to review the metadata the gateway provides. Use the picker refresh control after changing aix profiles or models; if the gateway cannot be reached, T3 keeps the last catalog and marks it stale.

For a LiteLLM API key with a reported budget, check its budget on the Usage page's Work tab. Put work projects in the Work scope to keep them out of the Personal view. The scope is an organizing aid, **not** an authentication or data boundary. For actual isolation, run separate servers with separate data directories.

## Limits and downloads

- aix integration requires API-key profiles. ChatGPT OAuth profiles remain unsupported; regular T3 provider sign-ins, including subscription-based providers, continue to work.
- Native Codex and Claude Code routing is limited to combinations known to work. The OpenCode route covers supported chat models, but arbitrary gateway aliases and model compatibility are not guaranteed. T3 does not silently substitute another model or provider.
- Model metadata may be absent. Budget windows and reset times are shown only when the gateway reports them.
- The fork's Android app is signed separately, replaces the Play Store app, and includes the Personal/Work switch. The official iOS and Android apps have no scope switch or extended model details and have not been verified against a fork server. There is no fork iOS app.
- Desktop builds cover Windows x64, Apple Silicon Macs, and Linux x64. The Nix flake builds from source for `x86_64-linux`.
- [Fork releases](https://github.com/Nitestack/t3code/releases) use upstream stable versions (for example, **T3 Code v0.1.10**). For Nix, `github:Nitestack/t3code/release` follows the latest published release after the first one; pin a release tag for a reproducible version. `main` includes unreleased fork changes. The [fork release runbook](./docs/operations/fork-release.md) explains the process. Upstream download links below install original T3 Code, not this fork.

For provider details, remote connections, troubleshooting, and mobile boundaries, see the [fork guide](./docs/user/nitestack-fork.md), [provider setup](./docs/user/install.md#providers), [remote access](./docs/user/remote-access.md), and [T3 Connect troubleshooting](./docs/user/t3-connect-troubleshooting.md).

## Original T3 Code README

The following is the complete upstream README from [`pingdotgg/t3code` revision `c2e54e3ac9c8c0d5ceaf7df5acd4f4374fa19b6f`](https://github.com/pingdotgg/t3code/commit/c2e54e3ac9c8c0d5ceaf7df5acd4f4374fa19b6f). Its install and download links are for **original T3 Code**, not this fork.

<details>
<summary>Show the full upstream README</summary>

<!-- prettier-ignore-start -->
<p align="center">
  <a href="https://t3.codes">
    <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="T3 Code logo" />
  </a>
</p>

<h1 align="center">T3 Code</h1>

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="https://t3.codes/download"><strong>Download</strong></a> ·
  <a href="https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824">iOS</a> ·
  <a href="https://play.google.com/store/apps/details?id=com.t3tools.t3code">Android</a> ·
  <a href="https://app.t3.codes">Web</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://discord.gg/jn4EGJjrvv">Discord</a>
</p>

<p align="center">
  <a href="https://t3.codes">
    <img src="./.github/readme/hero.webp" width="100%" alt="T3 Code on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
  </a>
</p>

T3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** MIT licensed. If you don't like something, fork it.

## Install

### Desktop app

[Download T3 Code](https://t3.codes/download) for macOS, Windows, or Linux. You can also use a package manager:

| Platform       | Command                                                              |
| -------------- | -------------------------------------------------------------------- |
| macOS          | `brew install --cask t3-code`                                        |
| Windows        | `winget install T3Tools.T3Code` or `scoop install extras/t3code`     |
| Arch Linux     | `yay -S t3code-bin`                                                  |
| Nix            | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`         |
| Debian, Ubuntu | `.deb` from [Releases](https://github.com/pingdotgg/t3code/releases) |

### Command line

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the tool that you want.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

[MIT](./LICENSE)

<!-- prettier-ignore-end -->

</details>
