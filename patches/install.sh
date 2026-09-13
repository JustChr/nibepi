#!/bin/bash
# Installs or updates NibePi from an unpacked source tree. Runs as root.
#
#   install.sh <src-dir> [--restart]
#
# This is the one install path. setup.sh calls it for a fresh install or a
# manual update, and nibepi-update.service calls it for an update started from
# the web UI. The old in-bridge updater repeated these steps by hand and
# drifted from setup.sh — for a while it skipped patches/ entirely while still
# reporting success — so there is deliberately no second copy any more.
#
# --restart restarts bridge.service at the end. setup.sh leaves it off because
# it may reboot instead.

set -e

[ "$(id -u)" -eq 0 ] || { echo "install.sh must run as root" >&2; exit 1; }
SRC=$(cd "$1" 2>/dev/null && pwd) || { echo "usage: install.sh <src-dir> [--restart]" >&2; exit 1; }
[ -f "$SRC/bridge.js" ] || { echo "No NibePi source tree at $SRC" >&2; exit 1; }
RESTART=0
[ "$2" = "--restart" ] && RESTART=1
# The caller's working directory may be the app dir this script is about to
# swap away (the 1.7.x updater runs from /opt/nibepi); every child would then
# start with "getcwd: cannot access parent directories".
cd /

APP=/opt/nibepi
STAGE=/opt/nibepi.new
OLD=/opt/nibepi.old
CONFIG_DIR=/etc/nibepi
SVC_USER=nibepi
PID_FILE=/dev/shm/nibepi_backend.pid
NPM=/usr/local/bin/npm

step() { echo ""; echo "▸ $*"; }
ok()   { echo "  ✓ $*"; }

SWAP_CREATED=0
cleanup() {
    [ "$SWAP_CREATED" = 1 ] && { swapoff /swapfile 2>/dev/null; rm -f /swapfile; }
    # Only a failed run leaves a stage behind; the live install is untouched.
    rm -rf "$STAGE"
}
trap cleanup EXIT

mount -o remount,rw /

# ── 1. Service account ────────────────────────────────────────────────────────
# bridge.js used to run as pi — the SSH login, with passwordless sudo — so any
# flaw in its HTTP API was a root shell. nibepi is a system account with no
# login and no password, and sudo for exactly the commands listed below.
# System accounts are also exempt from logind's RemoveIPC, which deleted the
# backend PID file in /dev/shm whenever pi logged out.
step "Service account..."
if ! id "$SVC_USER" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent \
            --shell /usr/sbin/nologin "$SVC_USER"
    ok "Created system user $SVC_USER."
fi
usermod -a -G dialout "$SVC_USER"   # /dev/ttyAMA0 is root:dialout 0660

mkdir -p "$CONFIG_DIR"
chown -R "$SVC_USER:$SVC_USER" "$CONFIG_DIR"
# Holds the MQTT password; nobody but the bridge (and root) has any business in it.
chmod 750 "$CONFIG_DIR"
[ -f "$CONFIG_DIR/config.json" ] && chmod 600 "$CONFIG_DIR/config.json"

# Resolved here rather than hard-coded: /usr/bin on merged-/usr systems (Trixie),
# /bin on Bullseye. sudo matches the rule by path and inode either way.
MOUNT=$(command -v mount)
SYSTEMCTL=$(command -v systemctl)
SUDOERS_TMP=$(mktemp)
cat > "$SUDOERS_TMP" << EOF
# Installed by NibePi. The bridge's service account may run these as root and
# nothing else: remounting / around config saves, restarting itself, and
# starting the updater (which decides on its own what to install).
$SVC_USER ALL=(root) NOPASSWD: $MOUNT -o remount\\,rw /, $MOUNT -o remount\\,ro /, $SYSTEMCTL restart bridge, $SYSTEMCTL start --no-block nibepi-update.service
EOF
# A broken sudoers file can lock root out of sudo entirely — never install one
# visudo has not accepted.
visudo -cqf "$SUDOERS_TMP"
install -m 440 "$SUDOERS_TMP" /etc/sudoers.d/nibepi
rm -f "$SUDOERS_TMP"
ok "sudo rules for $SVC_USER installed."

# ── 2. App files, staged ──────────────────────────────────────────────────────
# Built beside the live install and swapped in only once complete, so a failed
# npm install leaves the running version whole instead of half-replaced.
step "Staging $STAGE..."
rm -rf "$STAGE" "$OLD"
mkdir -p "$STAGE"
cp    "$SRC/bridge.js" "$SRC/backend.js" "$SRC/package.json" "$STAGE/"
cp -r "$SRC/ui" "$SRC/lib" "$SRC/models" "$STAGE/"
install -m 755 "$SRC/patches/update.sh" "$STAGE/update.sh"
# Root timers run these from the app dir; carry them across so the swap never
# leaves a window without them. harden.sh refreshes them afterwards.
for f in netwatch.sh timesync.sh; do
    [ -f "$APP/$f" ] && cp -a "$APP/$f" "$STAGE/"
done

PKG_HASH=$(md5sum "$STAGE/package.json" | cut -d' ' -f1)
OLD_HASH=$(cat "$APP/node_modules/.nibepi_pkg_hash" 2>/dev/null || true)
if [ "$PKG_HASH" = "$OLD_HASH" ] && [ -d "$APP/node_modules/serialport" ]; then
    # Hard links: no SD writes, no time, and nothing touches them in this branch.
    cp -al "$APP/node_modules" "$STAGE/node_modules"
    ok "npm dependencies unchanged."
else
    step "Installing npm dependencies (~6 min on a Pi Zero W)..."
    # A real copy, not links: npm rewrites files in place.
    [ -d "$APP/node_modules" ] && cp -a "$APP/node_modules" "$STAGE/node_modules"
    # Trixie ships swap already; only add our own if there is none at all, so we
    # never stack a second swap file on the SD card.
    if [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
        echo "  Adding 512 MB swap for compilation..."
        fallocate -l 512M /swapfile
        chmod 600 /swapfile
        mkswap /swapfile >/dev/null
        swapon /swapfile
        SWAP_CREATED=1
    fi
    (cd "$STAGE" && "$NPM" install --omit=dev --no-audit --no-fund)
    echo "$PKG_HASH" > "$STAGE/node_modules/.nibepi_pkg_hash"
    ok "npm dependencies installed."
fi

# Root-owned and not writable by the service account: a compromised bridge must
# not be able to rewrite its own code, nor the scripts root timers execute.
chown -R root:root "$STAGE"
chmod -R go-w "$STAGE"

step "Installing to $APP..."
[ -d "$APP" ] && mv "$APP" "$OLD"
mv "$STAGE" "$APP"
# Empty the old tree but keep its directory. The 1.7.x updater runs with its
# working directory there, and a process sitting in a deleted directory pins it
# as an orphan inode, which makes every `remount,ro /` fail with "mount point is
# busy" until that process exits. The next install removes the empty directory.
find "$OLD" -mindepth 1 -delete
ok "Files installed."

# ── 3. systemd units ──────────────────────────────────────────────────────────
step "Installing systemd units..."
install -m 644 "$SRC/patches/bridge.service"        /etc/systemd/system/bridge.service
install -m 644 "$SRC/patches/nibepi-update.service" /etc/systemd/system/nibepi-update.service
systemctl daemon-reload
systemctl enable bridge >/dev/null 2>&1
ok "bridge.service and nibepi-update.service installed."

# ── 4. Hardening ──────────────────────────────────────────────────────────────
step "Applying hardening..."
NIBEPI_INSTALLING=1 bash "$SRC/patches/harden.sh" ||
    echo "  ! harden.sh failed (app update still applied)"

# ── 5. Restart ────────────────────────────────────────────────────────────────
# node processes running backend.js as some other user — pi, on every install
# from before the service account existed. The new backend runs as nibepi and
# may not signal them, so the SIGUSR2 handover cannot happen and the old one
# would hold the serial port for its whole 10-minute zombie timeout. Root hands
# the port over instead. Matched on comm and cmdline, never `pkill -f`, which
# would also hit any shell whose command line mentions backend.js.
foreign_backends() {
    for p in $(pgrep -f 'backend\.js' || true); do
        [ "$(cat "/proc/$p/comm" 2>/dev/null)" = node ] || continue
        [ "$(stat -c %U "/proc/$p" 2>/dev/null)" = "$SVC_USER" ] && continue
        echo "$p"
    done
}

FOREIGN=$(foreign_backends)
if [ "$RESTART" = 1 ] || { [ -n "$FOREIGN" ] && systemctl is-active --quiet bridge; }; then
    step "Restarting bridge..."
    # /dev/shm is sticky: nibepi can neither overwrite nor replace a PID file
    # another user wrote, and the handover needs it to record its own pid.
    [ -f "$PID_FILE" ] && chown "$SVC_USER:$SVC_USER" "$PID_FILE"
    rm -f /tmp/nibepi_backend.pid
    systemctl restart bridge
    if [ -n "$FOREIGN" ]; then
        # Release the port once the new backend is up and retrying for it
        # (every 3 s), so the pump is without ACKs for seconds, not minutes.
        for _ in $(seq 1 60); do
            pgrep -u "$SVC_USER" -f 'backend\.js' >/dev/null && break
            sleep 1
        done
        sleep 2
        for p in $FOREIGN; do kill -USR2 "$p" 2>/dev/null || true; done
        sleep 5
        # One wedged in serialport.close() ignores everything but SIGKILL.
        for p in $FOREIGN; do
            [ "$(cat "/proc/$p/comm" 2>/dev/null)" = node ] && kill -KILL "$p" 2>/dev/null
        done
        ok "Serial port handed over from the previous backend (pid$(printf ' %s' $FOREIGN))."
    fi
    ok "bridge restarted."

    # ── 6. Read-only root again ───────────────────────────────────────────────
    # harden.sh already tried, but it fails as busy while the previous backend
    # still maps the serialport addon from the tree deleted above; that ends
    # with the handover, seconds after the restart. Only on this path: setup.sh
    # still cleans up after us, and before its first reboot /tmp is not yet a
    # tmpfs.
    for _ in $(seq 1 20); do
        if mount -o remount,ro / 2>/dev/null; then ok "Root filesystem read-only again."; break; fi
        sleep 3
    done
    findmnt -n -o OPTIONS / | grep -q '^ro' ||
        echo "  ! Root filesystem still writable (busy); it is read-only again from the next boot."
fi
