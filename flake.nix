{
  description = "Pinned Nix package for the T3 Code fork";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/d4f25a3e562008648d45bcf2d70bcc7422cad84e";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      revision = builtins.substring 0 7 (self.rev or "working-tree");
      version = "0.1.9-fork.${revision}";
      src = pkgs.runCommand "t3code-fork-source" { } ''
        mkdir -p "$out"
        cp -R ${self.outPath}/. "$out/"
      '';

      t3codeForkUnwrapped = pkgs.t3code.unwrapped.overrideAttrs (old: {
        pname = "t3code-fork-unwrapped";
        inherit version src;
        meta = old.meta // {
          changelog = "https://github.com/Nitestack/t3code/commit/${self.rev or revision}";
        };
        pnpmDeps = pkgs.fetchPnpmDeps {
          pname = "t3code-fork-unwrapped";
          inherit version src;
          pnpm = pkgs.pnpm_12;
          inherit (old) pnpmWorkspaces;
          fetcherVersion = 5;
          hash = "sha256-pYb9FqBoYJp1AW3HK0uwNinmi0TgcTbQJQA8Yv1Hr8I=";
        };
      });

      t3codeForkRuntime = pkgs.t3code.override {
        t3code-unwrapped = t3codeForkUnwrapped;
      };

      t3codeFork = pkgs.symlinkJoin {
        name = "t3code-fork-${version}";
        paths = [
          t3codeForkRuntime
          (pkgs.makeDesktopItem {
            name = "t3code-fork";
            desktopName = "T3 Code (Fork)";
            comment = "Minimal web GUI for coding agents";
            exec = "t3code-fork-desktop %U";
            terminal = false;
            icon = "t3code";
            startupWMClass = "t3code";
            categories = [ "Development" ];
          })
        ];
        nativeBuildInputs = [ pkgs.makeBinaryWrapper ];
        postBuild = ''
          rm -f "$out/bin/t3" "$out/bin/t3code-desktop"
          rm -f "$out/share/applications/t3code.desktop"
          makeWrapper "${t3codeForkRuntime}/bin/t3" "$out/bin/t3code-fork"
          makeWrapper "${t3codeForkRuntime}/bin/t3code-desktop" "$out/bin/t3code-fork-desktop"
        '';
        meta = t3codeForkRuntime.meta // {
          mainProgram = "t3code-fork-desktop";
        };
      };
    in
    {
      packages.${system} = {
        default = t3codeFork;
        t3code-fork = t3codeFork;
      };
    };
}
