#!/bin/sh
# Print the Homebrew formula for one published @simem/cli version.
#
#   scripts/homebrew-formula.sh 2.0.2 > ../homebrew-simem/Formula/simem.rb
#
# The formula lives in the tap repository github.com/thinhledev/homebrew-simem,
# so users install with `brew install thinhledev/simem/simem`. Run this after
# `npm publish`: the checksum is taken from the tarball on the npm registry.
# Pass a second argument (a local .tgz or another URL) only for testing.
set -eu

version=${1:?usage: scripts/homebrew-formula.sh <version> [tarball]}
url="https://registry.npmjs.org/@simem/cli/-/cli-${version}.tgz"
source=${2:-$url}

case "$source" in
  http://* | https://*)
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    curl -fsSL "$source" -o "$tmp"
    sha=$(shasum -a 256 "$tmp" | cut -d' ' -f1)
    ;;
  *)
    sha=$(shasum -a 256 "$source" | cut -d' ' -f1)
    url="file://$(cd "$(dirname "$source")" && pwd)/$(basename "$source")"
    ;;
esac

cat <<EOF
class Simem < Formula
  desc "Local project memory for AI coding agents, with fewer tokens per session"
  homepage "https://github.com/thinhledev/simem"
  url "${url}"
  sha256 "${sha}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    # Run with Homebrew's Node.js even when an older one comes first on PATH.
    (bin/"simem").write_env_script libexec/"bin/simem", PATH: "#{formula_opt_bin("node")}:\$PATH"
  end

  def caveats
    <<~EOS
      Connect simem to your coding agents (once per machine):
        simem init
      Then restart the Claude Code and Codex apps.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/simem --version")
  end
end
EOF
