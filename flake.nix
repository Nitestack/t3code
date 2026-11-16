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
          changelog = "https://github.com/Nitestack/t3code/commit/${self.rev or revision}";
        };
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
