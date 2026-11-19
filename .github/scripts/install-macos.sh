#!/bin/bash
# Installs or updates T3 Code on Apple Silicon from the get-aix/t3code releases.
# The app is not notarized. curl, unlike a browser, sets no quarantine flag, so
# Gatekeeper never checks the download and the app opens without a prompt.
# Usage: curl -fsSL <release>/install-macos.sh | bash   (T3CODE_VERSION=1.2.3 pins a version)
set -euo pipefail

repo="get-aix/t3code"

fail() {
  echo "error: $*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "this installer is for macOS."
[[ "$(uname -m)" == "arm64" ]] || fail "only Apple Silicon Macs are supported."

version="${T3CODE_VERSION:-}"
if [[ -z "$version" ]]; then
  latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")"
  version="${latest##*/v}"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-aix\.[0-9]+)?$ ]] || fail "could not resolve a release version (got '$version')."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
zip="T3-Code-$version-arm64.zip"
base="https://github.com/$repo/releases/download/v$version"

echo "Downloading T3 Code $version..."
curl -fL --progress-bar -o "$tmp/$zip" "$base/$zip"
curl -fsSL -o "$tmp/$zip.sha256" "$base/$zip.sha256"
(cd "$tmp" && shasum -a 256 -c "$zip.sha256" >/dev/null) || fail "checksum mismatch for $zip."

ditto -x -k "$tmp/$zip" "$tmp/unpacked"
src="$(find "$tmp/unpacked" -maxdepth 1 -name '*.app' -print -quit)"
[[ -n "$src" ]] || fail "the download contains no app."

# Apple Silicon refuses to run code without at least an ad-hoc signature.
if ! codesign --verify --deep --strict "$src" 2>/dev/null; then
  codesign --force --deep --sign - "$src"
fi

dest_dir="/Applications"
[[ -w "$dest_dir" ]] || dest_dir="$HOME/Applications"
mkdir -p "$dest_dir"
dest="$dest_dir/$(basename "$src")"

executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$src/Contents/Info.plist")"
# Replacing the app under a running T3 Code would stop its agents mid-turn.
pgrep -qx "$executable" && fail "T3 Code is running; quit it and run this again."

rm -rf "$dest"
ditto "$src" "$dest"
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true

echo "Installed T3 Code $version to $dest"
open "$dest"
