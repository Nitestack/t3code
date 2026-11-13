# Reproducible NixOS development environment

The repository includes a pinned devenv shell for development on NixOS. It
provides Node.js 26, the repository-selected pnpm version, `pkg-config`,
`libsecret`, and the shared libraries used by Electron and Playwright's Linux
browser. It does not install project dependencies, download a browser, or start
T3 Code automatically.

From the repository root, enter the shell and install the lockfile dependencies:

```sh
devenv shell
pnpm install --frozen-lockfile
```

The Node.js version follows the pinned Nixpkgs revision in `devenv.lock`. The
root `packageManager` field selects pnpm 12.14.0; Vite+ and Playwright versions
remain pinned by `pnpm-lock.yaml`.

Playwright downloads the browser revision required by the repository's locked
Playwright package into its normal user cache. From `apps/web`, install the
headless Chromium build when it is not already cached:

```sh
cd apps/web
pnpm exec playwright install chromium --only-shell
```

Do not set `PLAYWRIGHT_BROWSERS_PATH` to a Nixpkgs browser package. The shell
provides the NixOS shared libraries through `LD_LIBRARY_PATH`; Playwright still
launches the browser revision selected by `pnpm-lock.yaml`.

Run a browser test from `apps/web`:

```sh
vp test run --project browser src/components/Sidebar.browser.test.tsx
```

Run changed-file checks from the repository root:

```sh
vp run check:changed
```

To run the local T3 development server, start it explicitly from the worktree
inside the shell:

```sh
vp run dev
```

The development runner stores its state in the worktree's ignored `.t3`
directory. Entering devenv does not configure, restart, or attach to an already
running T3 server. A server launched in this shell inherits the browser runtime
libraries; no `VITE_HTTP_URL` or `VITE_WS_URL` override is needed.
