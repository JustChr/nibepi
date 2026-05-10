#!/bin/bash
# NibePi – one-shot install / update
#
# Run on a freshly flashed Pi (or to update an existing install):
#   bash <(wget -qO- https://raw.githubusercontent.com/JustChr/nibepi/master/setup.sh)

set -e

# Resolve latest GitHub release; fall back to master if API is unreachable
_TAG=$(wget -qO- https://api.github.com/repos/JustChr/nibepi/releases/latest \
       | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/' | head -1)
if [ -n "$_TAG" ]; then
    REPO_URL="https://github.com/JustChr/nibepi/archive/refs/tags/${_TAG}.tar.gz"
    echo "  Using release ${_TAG}"
else
    REPO_URL="https://github.com/JustChr/nibepi/archive/refs/heads/master.tar.gz"
    echo "  Could not resolve latest release, using master."
fi
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
rm -f /tmp/nibepi-reboot-needed

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
# disable-bt in harden.sh frees it — enable_uart=1 makes it available to userspace)
if ! grep -q 'enable_uart=1' /boot/config.txt; then
    echo 'enable_uart=1' | sudo tee -a /boot/config.txt > /dev/null
    touch /tmp/nibepi-reboot-needed
    ok "Hardware UART enabled."
else
    skip "Hardware UART (already enabled)"
fi

# Disable serial console so ttyAMA0 is free for RS485
if grep -qE 'console=(serial0|ttyAMA0)' /boot/cmdline.txt; then
    sudo sed -i 's/console=serial0,[0-9]* //g;s/console=ttyAMA0,[0-9]* //g' /boot/cmdline.txt
    touch /tmp/nibepi-reboot-needed
    ok "Serial console disabled."
else
    skip "Serial console (already disabled)"
fi

# ── 3. Node.js 18 ─────────────────────────────────────────────────────────────
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

# ── 4. Download repo ───────────────────────────────────────────────────────────
step "Downloading NibePi from GitHub..."
rm -rf /tmp/nibepi-src /tmp/nibepi.tar.gz
wget -q --show-progress -O /tmp/nibepi.tar.gz "$REPO_URL"
mkdir -p /tmp/nibepi-src
tar -xf /tmp/nibepi.tar.gz -C /tmp/nibepi-src --strip-components=1
rm -f /tmp/nibepi.tar.gz
REPO_DIR=/tmp/nibepi-src
ok "Downloaded."

# ── 5. Install app files ───────────────────────────────────────────────────────
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

# ── 6. npm install ─────────────────────────────────────────────────────────────
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

# ── 7. Config directory ────────────────────────────────────────────────────────
step "Setting up config directory..."
sudo mkdir -p "$CONFIG_DIR"
sudo chown pi:pi "$CONFIG_DIR"
ok "$CONFIG_DIR ready."

# ── 8. Systemd service ─────────────────────────────────────────────────────────
step "Installing systemd service..."
sudo cp "$REPO_DIR/patches/bridge.service" /etc/systemd/system/bridge.service
sudo systemctl daemon-reload
sudo systemctl enable bridge
ok "bridge.service enabled."

# ── 9. Harden ──────────────────────────────────────────────────────────────────
step "Applying hardening..."
bash "$REPO_DIR/patches/harden.sh"

# ── 10. Cleanup ────────────────────────────────────────────────────────────────
rm -rf /tmp/nibepi-src

# ── 11. Start or reboot ────────────────────────────────────────────────────────
if [ -f /tmp/nibepi-reboot-needed ]; then
    rm -f /tmp/nibepi-reboot-needed
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
