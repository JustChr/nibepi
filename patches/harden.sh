#!/bin/bash
# Hardens the Pi Zero W for 24/7 unattended operation:
#   - root filesystem read-only on boot (fstab)
#   - tmpfs for /tmp and /var/log (reduce SD card writes)
#   - hardware watchdog (auto-reboot on hang)
#   - disable Bluetooth (unused, saves power)
#   - bridge.service restart limits (reboot after 5 consecutive crashes)
#   - WiFi power save off + network watchdog (wlan0 is the only link on a Zero W)

set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
RAW_BASE="https://raw.githubusercontent.com/JustChr/nibepi/master/patches"

# Bookworm moved the FAT boot partition to /boot/firmware; Bullseye used /boot.
# Detect so this script works on both.
if [ -d /boot/firmware ]; then BOOT_DIR=/boot/firmware; else BOOT_DIR=/boot; fi

# Install a companion file from patches/. When harden.sh is run standalone via
# `bash <(wget -qO- .../harden.sh)` there is no checkout to copy from, so fall
# back to fetching the file directly.
get_patch() {   # get_patch <name> <dest> <mode>
    if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/$1" ]; then
        sudo install -m "$3" "$SCRIPT_DIR/$1" "$2"
    else
        _t=$(mktemp)
        if wget -qO "$_t" "$RAW_BASE/$1"; then
            sudo install -m "$3" "$_t" "$2"
            rm -f "$_t"
        else
            rm -f "$_t"
            echo "  ! could not obtain $1 — skipping"
            return 1
        fi
    fi
}

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
if ! grep -q 'dtparam=watchdog=on' "$BOOT_DIR/config.txt"; then
    echo 'dtparam=watchdog=on' | sudo tee -a "$BOOT_DIR/config.txt"
    echo "Watchdog enabled in $BOOT_DIR/config.txt"
    touch /tmp/nibepi-reboot-needed
else
    echo 'Watchdog already enabled, skipping.'
fi

sudo sed -i 's/^#*RuntimeWatchdogSec=.*/RuntimeWatchdogSec=15/'   /etc/systemd/system.conf
sudo sed -i 's/^#*ShutdownWatchdogSec=.*/ShutdownWatchdogSec=2min/' /etc/systemd/system.conf
echo 'Systemd watchdog timers set.'

# ── 3. Disable Bluetooth ──────────────────────────────────────────────────────
if ! grep -q 'dtoverlay=disable-bt' "$BOOT_DIR/config.txt"; then
    echo 'dtoverlay=disable-bt' | sudo tee -a "$BOOT_DIR/config.txt"
    echo "Bluetooth disabled in $BOOT_DIR/config.txt"
    touch /tmp/nibepi-reboot-needed
else
    echo 'Bluetooth already disabled, skipping.'
fi

# ── 4. WiFi power save off ────────────────────────────────────────────────────
# brcmfmac on the Zero W enables power save by default ("brcmf_cfg80211_set_power_mgmt:
# power save enabled" in dmesg) and is well known for silently dropping the
# association and never coming back. The hardware watchdog cannot catch that:
# the kernel stays healthy, so the box just quietly leaves the network.
if systemctl is-active --quiet NetworkManager; then
    # Trixie manages wifi through NetworkManager, and its profiles are generated
    # by netplan — editing a single connection would be lost on regeneration.
    # A conf.d drop-in sets the default for every wifi connection instead.
    sudo mkdir -p /etc/NetworkManager/conf.d
    sudo tee /etc/NetworkManager/conf.d/00-nibepi-wifi-powersave.conf > /dev/null <<'EOF'
[connection]
# 2 = powersave disabled
wifi.powersave = 2
EOF
    # Apply to the running interface directly rather than bouncing the
    # connection, which would drop the SSH session doing the hardening.
    sudo /sbin/iw dev wlan0 set power_save off 2>/dev/null || true
    echo 'WiFi power save disabled (NetworkManager drop-in).'
else
    get_patch wifi-powersave-off.service /etc/systemd/system/wifi-powersave-off.service 644
    sudo systemctl enable wifi-powersave-off.service >/dev/null 2>&1
    sudo /sbin/iwconfig wlan0 power off 2>/dev/null || true
    echo 'WiFi power save disabled (iwconfig unit).'
fi

# ── 4b. DNS on a read-only root ───────────────────────────────────────────────
# NetworkManager rewrites /etc/resolv.conf whenever the link comes up, which a
# read-only root silently blocks — leaving the box with a resolv.conf containing
# no nameserver at all. Nothing obvious breaks (MQTT to a literal IP keeps
# working), but every hostname lookup fails: time sync never resolves a pool
# server, and update checks cannot reach GitHub.
# Point /etc/resolv.conf at NetworkManager's runtime copy under /run (tmpfs),
# which it can always write.
if systemctl is-active --quiet NetworkManager; then
    if [ -L /etc/resolv.conf ]; then
        echo 'resolv.conf already a symlink, skipping.'
    else
        sudo rm -f /etc/resolv.conf
        sudo ln -s /run/NetworkManager/resolv.conf /etc/resolv.conf
        echo 'resolv.conf symlinked to NetworkManager runtime copy (ro-root safe).'
    fi
fi

# ── 5. Network watchdog ───────────────────────────────────────────────────────
# Pings the default gateway once a minute and escalates: reassociate → bounce
# wlan0 → reload brcmfmac → reboot (rate-limited to once per 6 h, because a
# reboot cannot fix an upstream outage but does interrupt RS485).
sudo mkdir -p /opt/nibepi
get_patch netwatch.sh                /opt/nibepi/netwatch.sh                       755
get_patch nibepi-netwatch.service    /etc/systemd/system/nibepi-netwatch.service   644
get_patch nibepi-netwatch.timer      /etc/systemd/system/nibepi-netwatch.timer     644
sudo systemctl enable nibepi-netwatch.timer >/dev/null 2>&1
echo 'Network watchdog installed.'

# ── 5b. Time sync ─────────────────────────────────────────────────────────────
# fake-hwclock cannot save the time on a read-only root, so every boot starts
# from a stale timestamp and something must correct it. Correct time matters
# because it stamps the netwatch incident log — the only record that survives
# the reboot which fixes an outage.
#
# Trixie ships systemd-timesyncd, which handles this properly. The sntp timer is
# the fallback for older images, where ntpd proved useless: it listened fine and
# had -g but never reached a single pool server, leaving the clock 23 min out,
# and it refuses to step past its 1000 s panic threshold regardless.
if systemctl is-active --quiet systemd-timesyncd; then
    echo 'Time sync: systemd-timesyncd active, sntp timer not needed.'
elif command -v sntp >/dev/null 2>&1; then
    get_patch timesync.sh              /opt/nibepi/timesync.sh                       755
    get_patch nibepi-timesync.service  /etc/systemd/system/nibepi-timesync.service   644
    get_patch nibepi-timesync.timer    /etc/systemd/system/nibepi-timesync.timer     644
    sudo systemctl enable nibepi-timesync.timer >/dev/null 2>&1
    # ntpd and the sntp timer would fight over the clock; the timer is the one that works.
    if systemctl list-unit-files 2>/dev/null | grep -q '^ntp\.service'; then
        sudo systemctl disable --now ntp >/dev/null 2>&1 || true
        echo 'Disabled ntpd in favour of the sntp timer.'
    fi
    echo 'Time sync: sntp timer installed.'
else
    echo 'Time sync: WARNING — no systemd-timesyncd and no sntp; clock will drift.'
fi

# ── 6. Bridge service restart limits ─────────────────────────────────────────
sudo mkdir -p /etc/systemd/system/bridge.service.d
# These are [Unit] keys, not [Service]. Put in [Service] they are silently
# ignored ("Unknown key ... ignoring") and the crash-loop reboot never fires —
# which is exactly how it shipped until Trixie's systemd complained out loud.
sudo tee /etc/systemd/system/bridge.service.d/limits.conf > /dev/null << 'EOF'
[Unit]
StartLimitIntervalSec=120
StartLimitBurst=5
StartLimitAction=reboot
EOF
echo 'Bridge service restart limits applied.'

sudo systemctl daemon-reload

# Start the watchdog now rather than waiting for the next reboot — the whole
# point is to be running before the next drop.
sudo systemctl start nibepi-netwatch.timer >/dev/null 2>&1 || true

# Best effort: this fails with "mount point is busy" whenever something still
# holds a file open for writing on / — e.g. setup.sh's own log, before /tmp has
# become a tmpfs. fstab already carries ro, so the next boot is read-only either
# way; aborting here would strand setup.sh before it reboots.
sudo mount -o remount,ro / 2>/dev/null ||
    echo 'Note: could not remount ro now (fs busy) — ro takes effect at next boot.'

echo ''
if [ -f /tmp/nibepi-reboot-needed ]; then
    echo 'Done. A reboot is required to activate boot-level changes.'
else
    echo 'Done. No boot-level changes — no reboot required.'
fi
