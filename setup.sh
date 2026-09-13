#!/bin/bash
# NibePi – one-shot install / update
#
# Run on a freshly flashed Pi (or to update an existing install):
#   bash <(wget -qO- https://raw.githubusercontent.com/JustChr/nibepi/master/setup.sh)
#
# This prepares the OS (filesystem, UART, hostname, Node.js) and fetches the
# release; installing the app itself is patches/install.sh, the same script the
# updater in the web UI runs.

set -e

# Resolve latest GitHub release; fall back to master if API is unreachable
_TAG=$(wget -qO- https://api.github.com/repos/JustChr/nibepi/releases/latest \
       | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/' | head -1)
if [[ "$_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    REPO_URL="https://github.com/JustChr/nibepi/archive/refs/tags/${_TAG}.tar.gz"
    echo "  Using release ${_TAG}"
else
    REPO_URL="https://github.com/JustChr/nibepi/archive/refs/heads/master.tar.gz"
    echo "  Could not resolve latest release, using master."
fi

# Bookworm moved the FAT boot partition to /boot/firmware; on Bullseye it is /boot.
# Detect rather than hard-code so this works on both.
if [ -d /boot/firmware ]; then BOOT_DIR=/boot/firmware; else BOOT_DIR=/boot; fi

# v22 is the newest Node with armv6l builds — 24 and later are not built for
# ARMv6 at all, so this is the ceiling on a Pi Zero W, not a preference.
NODE_TARGET="v22.23.2"
NODE_URL="https://unofficial-builds.nodejs.org/download/release/${NODE_TARGET}/node-${NODE_TARGET}-linux-armv6l.tar.xz"
# From that release's SHASUMS256.txt. Pinned here, where it arrives from GitHub
# rather than from the download server, so a tampered or truncated tarball is
# refused instead of being unpacked into /usr/local as root. Update with NODE_TARGET.
NODE_SHA256="ffc3ded26e63837d9ab7c3ab6da80e975de9594d57432ef0541237a46b080754"

# ── helpers ───────────────────────────────────────────────────────────────────
step() { echo ""; echo "▸ $*"; }
ok()   { echo "  ✓ $*"; }
skip() { echo "  – $* (already done, skipping)"; }

echo ""
echo "┌─────────────────────────────────────┐"
echo "│          NibePi Setup               │"
echo "└─────────────────────────────────────┘"

sudo mount -o remount,rw /
# May have been left by a root-run install.sh, which a plain rm cannot remove from sticky /tmp.
sudo rm -f /tmp/nibepi-reboot-needed

# ── 1. Expand filesystem ──────────────────────────────────────────────────────
step "Expanding filesystem to full card size..."
ROOT_DEV=$(findmnt -n -o SOURCE /)
DISK=$(echo "$ROOT_DEV" | sed 's/p\?[0-9]*$//')
PART=$(echo "$ROOT_DEV" | grep -o '[0-9]*$')
sudo parted -s "$DISK" resizepart "$PART" 100% 2>/dev/null || true
sudo resize2fs "$ROOT_DEV" 2>/dev/null || true
ok "Filesystem expanded."

# ── 2. Pi hardware configuration ─────────────────────────────────────────────
step "Configuring Pi hardware..."

# Hostname
CURRENT_HOST=$(hostname)
if [ "$CURRENT_HOST" != "nibepi" ]; then
    echo 'nibepi' | sudo tee /etc/hostname > /dev/null
    sudo sed -i "s/127.0.1.1.*/127.0.1.1\tnibepi/" /etc/hosts 2>/dev/null || \
        echo "127.0.1.1	nibepi" | sudo tee -a /etc/hosts > /dev/null
    touch /tmp/nibepi-reboot-needed
    ok "Hostname set to nibepi."
else
    skip "Hostname (already nibepi)"
fi

# Enable hardware UART for RS485 (Pi Zero W: PL011 is occupied by BT by default;
# disable-bt in harden.sh frees it — enable_uart=1 makes it available to userspace).
# On Trixie config.txt lives under /boot/firmware, hence $BOOT_DIR.
if ! grep -q 'enable_uart=1' "$BOOT_DIR/config.txt"; then
    echo 'enable_uart=1' | sudo tee -a "$BOOT_DIR/config.txt" > /dev/null
    touch /tmp/nibepi-reboot-needed
    ok "Hardware UART enabled."
else
    skip "Hardware UART (already enabled)"
fi

# Disable serial console so ttyAMA0 is free for RS485
if grep -qE 'console=(serial0|ttyAMA0)' "$BOOT_DIR/cmdline.txt"; then
    sudo sed -i 's/console=serial0,[0-9]* //g;s/console=ttyAMA0,[0-9]* //g' "$BOOT_DIR/cmdline.txt"
    touch /tmp/nibepi-reboot-needed
    ok "Serial console disabled."
else
    skip "Serial console (already disabled)"
fi

# ── 3. Node.js ────────────────────────────────────────────────────────────────
step "Checking Node.js..."
CURRENT_NODE=$(/usr/local/bin/node --version 2>/dev/null || echo "none")
if [ "$CURRENT_NODE" = "$NODE_TARGET" ]; then
    skip "Node.js $NODE_TARGET"
else
    echo "  Installing Node.js $NODE_TARGET (current: $CURRENT_NODE)..."
    wget -q --show-progress -O /tmp/node.tar.xz "$NODE_URL"
    if ! echo "$NODE_SHA256  /tmp/node.tar.xz" | sha256sum -c --quiet -; then
        rm -f /tmp/node.tar.xz
        echo "  ✗ Node.js download does not match its pinned checksum — refusing to install it."
        exit 1
    fi
    tar -xf /tmp/node.tar.xz -C /tmp/
    sudo cp -r /tmp/node-${NODE_TARGET}-linux-armv6l/bin/* /usr/local/bin/
    sudo cp -r /tmp/node-${NODE_TARGET}-linux-armv6l/lib/* /usr/local/lib/
    rm -rf /tmp/node-${NODE_TARGET}-linux-armv6l /tmp/node.tar.xz
    ok "Node.js $(/usr/local/bin/node --version) installed."
fi

# ── 4. Obtain repo ─────────────────────────────────────────────────────────────
# NIBEPI_LOCAL_SRC lets you install a working tree that has not been released
# yet — needed to test changes on the Pi before tagging them.
if [ -n "$NIBEPI_LOCAL_SRC" ] && [ -d "$NIBEPI_LOCAL_SRC" ]; then
    REPO_DIR="$NIBEPI_LOCAL_SRC"
    step "Using local source $REPO_DIR (skipping download)"
else
    step "Downloading NibePi from GitHub..."
    rm -rf /tmp/nibepi-src /tmp/nibepi.tar.gz
    wget -q --show-progress -O /tmp/nibepi.tar.gz "$REPO_URL"
    mkdir -p /tmp/nibepi-src
    tar -xf /tmp/nibepi.tar.gz -C /tmp/nibepi-src --strip-components=1
    rm -f /tmp/nibepi.tar.gz
    REPO_DIR=/tmp/nibepi-src
    ok "Downloaded."
fi

# ── 5. Install ─────────────────────────────────────────────────────────────────
# Service account, app files, npm dependencies, systemd units, sudo rules and
# hardening. No restart: step 7 decides between restart and reboot.
sudo bash "$REPO_DIR/patches/install.sh" "$REPO_DIR"

# ── 6. Cleanup ─────────────────────────────────────────────────────────────────
# Never delete a caller-supplied local source tree.
[ -n "$NIBEPI_LOCAL_SRC" ] || rm -rf /tmp/nibepi-src

# ── 7. Start or reboot ────────────────────────────────────────────────────────
if [ -f /tmp/nibepi-reboot-needed ]; then
    sudo rm -f /tmp/nibepi-reboot-needed
    echo ""
    echo "┌─────────────────────────────────────┐"
    echo "│  Done! Rebooting in 5 seconds...    │"
    echo "│                                     │"
    echo "│  Open http://nibepi:1880 once the   │"
    echo "│  Pi comes back online.              │"
    echo "└─────────────────────────────────────┘"
    sleep 5
    sudo reboot
else
    sudo systemctl restart bridge
    echo ""
    echo "┌─────────────────────────────────────┐"
    echo "│  Done! No reboot needed.            │"
    echo "│                                     │"
    echo "│  Open http://nibepi:1880            │"
    echo "└─────────────────────────────────────┘"
fi
