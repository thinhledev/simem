#!/bin/sh
# Installs the standalone mixai binary (no Node.js needed) and sets it up for
# every Claude Code and Codex account on this machine.
#   curl -fsSL https://github.com/thinhledev/mixai/releases/latest/download/install.sh | sh
# Set MIXAI_VERSION=v2.0.0 to pin a release. Everything stays on this machine.
set -eu

REPO="thinhledev/mixai"
VERSION="${MIXAI_VERSION:-latest}"
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "mixai: unsupported OS $(uname -s); install with npm instead: npm i -g mixai-cli" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "mixai: unsupported CPU $(uname -m); install with npm instead: npm i -g mixai-cli" >&2; exit 1 ;;
esac
asset="mixai-$os-$arch"
if [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"; else base="https://github.com/$REPO/releases/download/$VERSION"; fi

dir="${MIXAI_HOME:-$HOME/.mixai}/standalone"
mkdir -p "$dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $asset ($VERSION)…"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"; else actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"; fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "mixai: checksum mismatch for $asset; not installing." >&2
  exit 1
fi
chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$dir/mixai"
echo "Installed $dir/mixai ($("$dir/mixai" --version))"

# Put `mixai` on PATH when ~/.local/bin is a PATH directory.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) mkdir -p "$HOME/.local/bin" && ln -sf "$dir/mixai" "$HOME/.local/bin/mixai" ;;
  *) echo "Tip: add $dir to your PATH to run \`mixai\` from a terminal." ;;
esac

"$dir/mixai" init
