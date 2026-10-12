#!/bin/sh
# Installs the standalone simem binary (no Node.js needed) and sets it up for
# every Claude Code and Codex account on this machine.
#   curl -fsSL https://github.com/thinhledev/simem/releases/latest/download/install.sh | sh
# Set SIMEM_VERSION=v2.0.0 to pin a release. Everything stays on this machine.
set -eu

REPO="thinhledev/simem"
VERSION="${SIMEM_VERSION:-latest}"
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "simem: unsupported OS $(uname -s); install with npm instead: npm i -g @simem/cli" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "simem: unsupported CPU $(uname -m); install with npm instead: npm i -g @simem/cli" >&2; exit 1 ;;
esac
asset="simem-$os-$arch"
if [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"; else base="https://github.com/$REPO/releases/download/$VERSION"; fi

dir="${SIMEM_HOME:-$HOME/.simem}/standalone"
mkdir -p "$dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $asset ($VERSION)…"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"; else actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"; fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "simem: checksum mismatch for $asset; not installing." >&2
  exit 1
fi
chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$dir/simem"
echo "Installed $dir/simem ($("$dir/simem" --version))"

# Put `simem` on PATH when ~/.local/bin is a PATH directory.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) mkdir -p "$HOME/.local/bin" && ln -sf "$dir/simem" "$HOME/.local/bin/simem" ;;
  *) echo "Tip: add $dir to your PATH to run \`simem\` from a terminal." ;;
esac

"$dir/simem" init
