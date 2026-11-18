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
          hash = "sha256-27Ljt2lY4J1Fi3ddVIflPQ5erRqmgaZ8+YBH9fhCLzo=";
        };
      });

      t3code = (pkgs.t3code.override {
        t3code-unwrapped = t3codeUnwrapped;
      }).overrideAttrs (old: {
        pname = "t3code";
        inherit version;
        name = "t3code-${version}";
        # The desktop registers itself as the t3code:// handler (T3 Connect sign-in callback);
        # without this it would register the shared bare Electron binary instead.
        # symlinkJoin bakes postBuild into buildCommand, so overriding postBuild is a no-op.
        # aix profiles are on by default in this build; T3CODE_AIX=0 turns them off.
        buildCommand = old.buildCommand + ''
          wrapProgram "$out/bin/t3code-desktop" \
            --set-default T3CODE_DESKTOP_LAUNCHER_PATH "$out/bin/t3code-desktop"
          for program in "$out/bin"/*; do
            wrapProgram "$program" --set-default T3CODE_AIX 1
          done
        '';
        meta = old.meta // {
          mainProgram = "t3code-desktop";
        };
      });
    in
    {
      packages.${system} = {
        default = t3code;
        inherit t3code;
      };
    };
}
