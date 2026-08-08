#!/bin/bash
# Hardens the Pi Zero W for 24/7 unattended operation:
#   - root filesystem read-only on boot (fstab)
#   - tmpfs for /tmp and /var/log (reduce SD card writes)
#   - hardware watchdog (auto-reboot on hang)
#   - disable Bluetooth (unused, saves power)
#   - bridge.service restart limits (reboot after 5 consecutive crashes)
#   - WiFi power save off + network watchdog (wlan0 is the only link on a Zero W)

set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

sudo mount -o remount,rw /

# ── 1. Root filesystem read-only on boot ──────────────────────────────────────
# Ensure the root fstab entry has 'ro' so every boot starts with a protected
# filesystem. bridge.js remounts rw temporarily only when saving config.
ROOT_FSTAB=$(grep -E '\s+/\s+ext4' /etc/fstab | head -1)
if echo "$ROOT_FSTAB" | grep -qE '\bro\b'; then
    echo 'Root already ro in fstab, skipping.'
else
    # Replace the options field (4th column) on the root ext4 line
    sudo sed -i -E 's|^([^#]\S+\s+/\s+ext4\s+)\S+|\1ro,noatime|' /etc/fstab
    echo 'Root filesystem set to ro,noatime in fstab.'
fi

# ── 2. tmpfs for /tmp and /var/log ────────────────────────────────────────────
if ! grep -q 'tmpfs.*\/tmp' /etc/fstab; then
    echo 'tmpfs  /tmp     tmpfs  defaults,noatime,size=32m  0  0' | sudo tee -a /etc/fstab
    echo 'Added tmpfs /tmp'
    touch /tmp/nibepi-reboot-needed
else
    echo 'tmpfs /tmp already in fstab, skipping.'
fi

if ! grep -q 'tmpfs.*\/var\/log' /etc/fstab; then
    echo 'tmpfs  /var/log tmpfs  defaults,noatime,size=16m  0  0' | sudo tee -a /etc/fstab
    echo 'Added tmpfs /var/log'
    touch /tmp/nibepi-reboot-needed
else
    echo 'tmpfs /var/log already in fstab, skipping.'
fi

# ── 2. Hardware watchdog ──────────────────────────────────────────────────────
if ! grep -q 'dtparam=watchdog=on' /boot/config.txt; then
    echo 'dtparam=watchdog=on' | sudo tee -a /boot/config.txt
    echo 'Watchdog enabled in /boot/config.txt'
    touch /tmp/nibepi-reboot-needed
else
    echo 'Watchdog already enabled, skipping.'
fi

sudo sed -i 's/^#*RuntimeWatchdogSec=.*/RuntimeWatchdogSec=15/'   /etc/systemd/system.conf
sudo sed -i 's/^#*ShutdownWatchdogSec=.*/ShutdownWatchdogSec=2min/' /etc/systemd/system.conf
echo 'Systemd watchdog timers set.'

# ── 3. Disable Bluetooth ──────────────────────────────────────────────────────
if ! grep -q 'dtoverlay=disable-bt' /boot/config.txt; then
    echo 'dtoverlay=disable-bt' | sudo tee -a /boot/config.txt
    echo 'Bluetooth disabled in /boot/config.txt'
    touch /tmp/nibepi-reboot-needed
else
    echo 'Bluetooth already disabled, skipping.'
fi

# ── 4. WiFi power save off ────────────────────────────────────────────────────
# brcmfmac on the Zero W enables power save by default ("brcmf_cfg80211_set_power_mgmt:
# power save enabled" in dmesg) and is well known for silently dropping the
# association and never coming back. The hardware watchdog cannot catch that:
# the kernel stays healthy, so the box just quietly leaves the network.
sudo cp "$SCRIPT_DIR/wifi-powersave-off.service" /etc/systemd/system/wifi-powersave-off.service
sudo systemctl enable wifi-powersave-off.service >/dev/null 2>&1
sudo /sbin/iwconfig wlan0 power off 2>/dev/null || true
echo 'WiFi power save disabled.'

# ── 5. Network watchdog ───────────────────────────────────────────────────────
# Pings the default gateway once a minute and escalates: reassociate → bounce
# wlan0 → reload brcmfmac → reboot (rate-limited to once per 6 h, because a
# reboot cannot fix an upstream outage but does interrupt RS485).
sudo mkdir -p /opt/nibepi
sudo cp "$SCRIPT_DIR/netwatch.sh" /opt/nibepi/netwatch.sh
sudo chmod +x /opt/nibepi/netwatch.sh
sudo cp "$SCRIPT_DIR/nibepi-netwatch.service" /etc/systemd/system/nibepi-netwatch.service
sudo cp "$SCRIPT_DIR/nibepi-netwatch.timer"   /etc/systemd/system/nibepi-netwatch.timer
sudo systemctl enable nibepi-netwatch.timer >/dev/null 2>&1
echo 'Network watchdog installed.'

# ── 6. Bridge service restart limits ─────────────────────────────────────────
sudo mkdir -p /etc/systemd/system/bridge.service.d
sudo tee /etc/systemd/system/bridge.service.d/limits.conf > /dev/null << 'EOF'
[Service]
StartLimitIntervalSec=120
StartLimitBurst=5
StartLimitAction=reboot
EOF
echo 'Bridge service restart limits applied.'

sudo systemctl daemon-reload

# Start the watchdog now rather than waiting for the next reboot — the whole
# point is to be running before the next drop.
sudo systemctl start nibepi-netwatch.timer >/dev/null 2>&1 || true

sudo mount -o remount,ro /

echo ''
if [ -f /tmp/nibepi-reboot-needed ]; then
    echo 'Done. A reboot is required to activate boot-level changes.'
else
    echo 'Done. No boot-level changes — no reboot required.'
fi
