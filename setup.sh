#!/bin/bash
# NibePi – one-shot install / update
#
# Run on a freshly flashed Pi (or to update an existing install):
#   bash <(wget -qO- https://raw.githubusercontent.com/JustChr/nibepi/master/setup.sh)

set -e

REPO_URL="https://github.com/JustChr/nibepi/archive/refs/heads/master.tar.gz"
REPO_DIR="/tmp/nibepi-master"
INSTALL_DIR="/opt/nibepi"
CONFIG_DIR="/etc/nibepi"
NODE_TARGET="v18.20.8"
NODE_URL="https://unofficial-builds.nodejs.org/download/release/${NODE_TARGET}/node-${NODE_TARGET}-linux-armv6l.tar.xz"

# ── helpers ───────────────────────────────────────────────────────────────────
step() { echo ""; echo "▸ $*"; }
ok()   { echo "  ✓ $*"; }
skip() { echo "  – $* (already done, skipping)"; }

echo ""
echo "┌─────────────────────────────────────┐"
echo "│          NibePi Setup               │"
echo "└─────────────────────────────────────┘"

sudo mount -o remount,rw /

# ── 1. Expand filesystem ──────────────────────────────────────────────────────
step "Expanding filesystem to full card size..."
ROOT_DEV=$(findmnt -n -o SOURCE /)
DISK=$(echo "$ROOT_DEV" | sed 's/p\?[0-9]*$//')
PART=$(echo "$ROOT_DEV" | grep -o '[0-9]*$')
sudo parted -s "$DISK" resizepart "$PART" 100% 2>/dev/null || true
sudo resize2fs "$ROOT_DEV" 2>/dev/null || true
ok "Filesystem expanded."

# ── 2. Node.js 18 ─────────────────────────────────────────────────────────────
step "Checking Node.js..."
CURRENT_NODE=$(/usr/local/bin/node --version 2>/dev/null || echo "none")
if [ "$CURRENT_NODE" = "$NODE_TARGET" ]; then
    skip "Node.js $NODE_TARGET"
else
    echo "  Installing Node.js $NODE_TARGET (current: $CURRENT_NODE)..."
    wget -q --show-progress -O /tmp/node.tar.xz "$NODE_URL"
    tar -xf /tmp/node.tar.xz -C /tmp/
    sudo cp -r /tmp/node-${NODE_TARGET}-linux-armv6l/bin/* /usr/local/bin/
    sudo cp -r /tmp/node-${NODE_TARGET}-linux-armv6l/lib/* /usr/local/lib/
    rm -rf /tmp/node-${NODE_TARGET}-linux-armv6l /tmp/node.tar.xz
    ok "Node.js $(/usr/local/bin/node --version) installed."
fi

# ── 3. Download repo ───────────────────────────────────────────────────────────
step "Downloading NibePi from GitHub..."
rm -rf "$REPO_DIR"
wget -q --show-progress -O /tmp/nibepi.tar.gz "$REPO_URL"
tar -xf /tmp/nibepi.tar.gz -C /tmp/
rm -f /tmp/nibepi.tar.gz
ok "Downloaded."

# ── 4. Install app files ───────────────────────────────────────────────────────
step "Installing to $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR"
sudo chown pi:pi "$INSTALL_DIR"
cp    "$REPO_DIR/bridge.js"    "$INSTALL_DIR/"
cp    "$REPO_DIR/backend.js"   "$INSTALL_DIR/"
cp    "$REPO_DIR/package.json" "$INSTALL_DIR/"
cp -r "$REPO_DIR/ui"           "$INSTALL_DIR/"
cp -r "$REPO_DIR/lib"          "$INSTALL_DIR/"
cp -r "$REPO_DIR/models"       "$INSTALL_DIR/"
ok "Files installed."

# ── 5. npm install ─────────────────────────────────────────────────────────────
# Skip if node_modules is present and package.json hasn't changed.
PKG_HASH=$(md5sum "$INSTALL_DIR/package.json" | cut -d' ' -f1)
HASH_FILE="$INSTALL_DIR/node_modules/.nibepi_pkg_hash"
CACHED_HASH=$(cat "$HASH_FILE" 2>/dev/null || echo "")

if [ "$PKG_HASH" = "$CACHED_HASH" ] && [ -d "$INSTALL_DIR/node_modules/serialport" ]; then
    skip "npm dependencies (package.json unchanged)"
else
    step "Installing npm dependencies (~6 min on Pi Zero W)..."
    SWAP_CREATED=0
    if [ ! -f /swapfile ]; then
        echo "  Adding 512 MB swap for compilation..."
        sudo fallocate -l 512M /swapfile
        sudo chmod 600 /swapfile
        sudo mkswap /swapfile
        sudo swapon /swapfile
        SWAP_CREATED=1
    fi

    cd "$INSTALL_DIR" && /usr/local/bin/npm install

    if [ "$SWAP_CREATED" = "1" ]; then
        sudo swapoff /swapfile && sudo rm /swapfile
        ok "Swap removed."
    fi

    echo "$PKG_HASH" > "$HASH_FILE"
    ok "npm dependencies installed."
fi

# ── 6. Config directory ────────────────────────────────────────────────────────
step "Setting up config directory..."
sudo mkdir -p "$CONFIG_DIR"
sudo chown pi:pi "$CONFIG_DIR"
ok "$CONFIG_DIR ready."

# ── 7. Systemd service ─────────────────────────────────────────────────────────
step "Installing systemd service..."
sudo cp "$REPO_DIR/patches/bridge.service" /etc/systemd/system/bridge.service
sudo systemctl daemon-reload
sudo systemctl enable bridge
ok "bridge.service enabled."

# ── 8. Harden ──────────────────────────────────────────────────────────────────
step "Applying hardening..."
bash "$REPO_DIR/patches/harden.sh"

# ── 9. Cleanup ─────────────────────────────────────────────────────────────────
rm -rf "$REPO_DIR"

echo ""
echo "┌─────────────────────────────────────┐"
echo "│  Done! Rebooting in 5 seconds...    │"
echo "│                                     │"
echo "│  Open http://nibepi:1880 once the   │"
echo "│  Pi comes back online.              │"
echo "└─────────────────────────────────────┘"
sleep 5
sudo reboot
