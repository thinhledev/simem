#!/bin/sh
# Packages plugin/ (both the Claude Code and Codex manifests, the shared
# skills, and the icons) as the ZIP the directory portals take:
# build/plugin/simem-plugin-<version>.zip
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$root/package.json').version")"
out="$root/build/plugin"
mkdir -p "$out"
rm -f "$out/simem-plugin-$version.zip"
cd "$root/plugin"
zip -qr -X "$out/simem-plugin-$version.zip" . -x '.DS_Store' '*/.DS_Store'
echo "$out/simem-plugin-$version.zip"
