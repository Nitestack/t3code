{
  description = "Pinned Nix package for T3 Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/d4f25a3e562008648d45bcf2d70bcc7422cad84e";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      revision = builtins.substring 0 7 (self.rev or "working-tree");
      version = (builtins.fromJSON (builtins.readFile ./apps/server/package.json)).version;
      src = pkgs.runCommand "t3code-source" { } ''
        mkdir -p "$out"
        cp -R ${self.outPath}/. "$out/"
      '';

      t3codeUnwrapped = pkgs.t3code.unwrapped.overrideAttrs (old: {
        pname = "t3code-unwrapped";
        inherit version src;
        meta = old.meta // {
          changelog = "https://github.com/get-aix/t3code/commit/${self.rev or revision}";
        };
        # T3 Connect's public identifiers are compiled into the client and CLI.
        postPatch = (old.postPatch or "") + ''
          cp .env.example .env
        '';
        pnpmDeps = pkgs.fetchPnpmDeps {
          pname = "t3code-unwrapped";
          inherit version src;
          pnpm = pkgs.pnpm_12;
          inherit (old) pnpmWorkspaces;
          fetcherVersion = 5;
          hash = "sha256-s/vm8Ox4o/AYpNC/amYP1KFWwh7SY5bCmVBuIJn9f/c=";
        };
      });

      # Direct DT_NEEDED shared libraries of T3's downloaded chrome-headless-shell.
      # Scoped via NIX_LD_LIBRARY_PATH so nix-ld resolves them for the headless
      # browser without touching global nix-ld libraries or Nix-built binaries.
      browserRuntimeLibraryPath = pkgs.lib.makeLibraryPath (
        with pkgs;
        [
          alsa-lib
          at-spi2-core
          dbus.lib
          expat
          glib
          libgbm
          libx11
          libxcb
          libxcomposite
          libxdamage
          libxext
          libxfixes
          libxkbcommon
          libxrandr
          nspr
          nss
          systemdMinimal
        ]
      );

      # Free runtime tools needed by T3's local Android device support:
      # npm installs expo-device-hub and agent-device, ffmpeg (libx264) streams
      # emulator video, and java runs Android SDK's avdmanager.
      deviceToolsPath = pkgs.lib.makeBinPath (
        with pkgs;
        [
          nodejs
          ffmpeg
          jdk21_headless
        ]
      );

      # Lazily instantiated only when opting into unfree Android SDK packages.
      pkgsUnfree = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          android_sdk.accept_license = true;
        };
      };

      mkAndroidSdk =
        {
          platformVersions,
          systemImageTypes,
          abiVersions,
        }:
        let
          composition = pkgsUnfree.androidenv.composeAndroidPackages {
            cmdLineToolsVersion = "latest";
            includeEmulator = true;
            includeSystemImages = true;
            inherit platformVersions systemImageTypes abiVersions;
          };
        in
        # T3's LocalDeviceHost checks for cmdline-tools/latest/bin/avdmanager.
        pkgs.runCommand "t3code-android-sdk" { } ''
          mkdir -p "$out"
          cp -rs "${composition.androidsdk}/libexec/android-sdk/"* "$out/"
          chmod -R u+w "$out/cmdline-tools"
          if [ ! -e "$out/cmdline-tools/latest" ]; then
            first="$(find "$out/cmdline-tools" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
            ln -s "$first" "$out/cmdline-tools/latest"
          fi
        '';

      mkT3Code = pkgs.lib.makeOverridable (
        {
          withBrowser ? false,
          withAndroid ? false,
          androidPlatformVersions ? [ "35" ],
          androidSystemImageTypes ? [ "google_apis" ],
          androidAbiVersions ? [ "x86_64" ],
        }:
        let
          androidSdk = mkAndroidSdk {
            platformVersions = androidPlatformVersions;
            systemImageTypes = androidSystemImageTypes;
            abiVersions = androidAbiVersions;
          };
          extraWrapArgs =
            pkgs.lib.optionals withBrowser [
              "--suffix"
              "NIX_LD_LIBRARY_PATH"
              ":"
              browserRuntimeLibraryPath
            ]
            ++ pkgs.lib.optionals withAndroid [
              "--set-default"
              "ANDROID_HOME"
              "${androidSdk}"
              "--suffix"
              "PATH"
              ":"
              "${deviceToolsPath}:${androidSdk}/platform-tools:${androidSdk}/cmdline-tools/latest/bin:${androidSdk}/emulator"
            ];
        in
        (pkgs.t3code.override {
          t3code-unwrapped = t3codeUnwrapped;
        }).overrideAttrs (old: {
          pname = "t3code";
          inherit version;
          name = "t3code-${version}";
          # The desktop registers itself as the t3code:// handler (T3 Connect sign-in callback);
          # without this it would register the shared bare Electron binary instead.
          # symlinkJoin bakes postBuild into buildCommand, so overriding postBuild is a no-op.
          buildCommand =
            old.buildCommand
            + ''
              wrapProgram "$out/bin/t3code-desktop" \
                --set-default T3CODE_DESKTOP_LAUNCHER_PATH "$out/bin/t3code-desktop"
            ''
            + pkgs.lib.optionalString (extraWrapArgs != [ ]) ''
              for program in "$out/bin"/*; do
                wrapProgram "$program" ${pkgs.lib.escapeShellArgs extraWrapArgs}
              done
            '';
          meta = old.meta // {
            mainProgram = "t3code-desktop";
          };
        })
      );

      t3code = mkT3Code { };
      t3code-browser = mkT3Code { withBrowser = true; };
      t3code-android = mkT3Code { withAndroid = true; };
      t3code-full = mkT3Code {
        withBrowser = true;
        withAndroid = true;
      };
    in
    {
      packages.${system} = {
        default = t3code;
        inherit
          t3code
          t3code-browser
          t3code-android
          t3code-full
          ;
      };
    };
}
