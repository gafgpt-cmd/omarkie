#!/usr/bin/env bash
# Installs the latest jgm/pandoc amd64 .deb, verified against the release asset digest published by the GitHub API. Needs GH_TOKEN.
set -euo pipefail
asset=$(gh api repos/jgm/pandoc/releases/latest --jq '.assets[] | select(.name | endswith("-amd64.deb")) | "\(.browser_download_url) \(.digest // "")"' | head -n 1)
read -r url digest <<< "$asset"
[[ -n "${url:-}" ]] || { echo "No amd64 .deb asset in the latest Pandoc release" >&2; exit 1; }
[[ "${digest:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Missing sha256 digest for $url" >&2; exit 1; }
deb="$(mktemp -d)/pandoc.deb"
curl --fail --location --silent --show-error --retry 3 --retry-all-errors --connect-timeout 30 --max-time 300 "$url" --output "$deb"
echo "${digest#sha256:}  $deb" | sha256sum --check --strict
sudo apt-get install -y "$deb"
pandoc --version | head -n 1
