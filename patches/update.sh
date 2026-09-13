#!/bin/bash
# NibePi updater. Run as root by nibepi-update.service, which the bridge may
# start — and do nothing else with — through sudo.
#
# It takes no input. It asks GitHub for the latest release itself, so the web
# UI can only ever say "install the current release", never choose what gets
# installed. The bridge once took a download URL from the HTTP request and
# spliced it into a root shell script (issue #1).

set -e

REPO=JustChr/nibepi
WORK=/tmp/nibepi-update

TAG=$(wget -qO- "https://api.github.com/repos/$REPO/releases/latest" \
      | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/' | head -1)
# The tag becomes part of a URL and a path; anything but plain semver is refused.
if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Refusing release tag '$TAG'" >&2
    exit 1
fi
echo "Installing NibePi $TAG"

rm -rf "$WORK"
mkdir -p "$WORK/src"
trap 'rm -rf "$WORK"' EXIT
wget -qO "$WORK/release.tar.gz" "https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"
tar -xzf "$WORK/release.tar.gz" -C "$WORK/src" --strip-components=1

# The release's own installer, not this copy: it knows what that release needs.
bash "$WORK/src/patches/install.sh" "$WORK/src" --restart
