{ pkgs, ... }:

let
  browserRuntimeLibraries = with pkgs; [
    alsa-lib
    at-spi2-core
    dbus.lib
    expat
    glib
    gtk3
    libgbm
    libdrm
    libsecret
    libx11
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    libxcb
    libxkbcommon
    mesa
    nspr
    nss
    systemdMinimal
  ];
in
{
  packages = with pkgs; [
    git
    pkg-config
    libsecret
  ];

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_26;
    pnpm.enable = true;
    pnpm.package = pkgs.pnpm_12;
  };

  # Playwright downloads the browser revision from pnpm-lock.yaml into its
  # normal user cache. These libraries let that pinned browser run on NixOS.
  env.LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath browserRuntimeLibraries;
}
