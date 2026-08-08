#!/bin/bash
# NibePi network watchdog
#
# The hardware watchdog (RuntimeWatchdogSec) only catches a hung kernel. A Pi
# Zero W whose wlan0 silently drops association keeps the kernel perfectly
# healthy — systemd keeps petting the watchdog while the box is unreachable and
# the RS485 loop keeps the heat pump happy. That blind spot is what this closes.
#
# Run every minute by nibepi-netwatch.timer. Escalates gently, and records what
# it saw to /boot so the next outage leaves evidence behind (/var/log is tmpfs,
# so anything logged there dies with the reboot that fixes the problem).

IFACE=wlan0
STATE=/run/nibepi-netwatch.fails      # tmpfs: resets at boot, no SD wear
BOOTDIR=/boot                          # vfat, mounted rw, survives reboots
EVENTLOG="$BOOTDIR/nibepi-netwatch.log"
REBOOTSTAMP="$BOOTDIR/nibepi-netwatch.reboot"
REBOOT_COOLDOWN=21600                  # 6 h between watchdog reboots
MAXLOG=250                             # trim event log beyond this many lines

# Escalation thresholds, in consecutive failed minutes
L1_REASSOC=3
L2_IFACE=6
L3_MODULE=10
L4_REBOOT=15

say() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$EVENTLOG" 2>/dev/null
    logger -t nibepi-netwatch "$*" 2>/dev/null
}

# Radio state at the moment of trouble — the diagnostics we wished we had.
radio_state() {
    local iw ap sig
    iw=$(/sbin/iwconfig "$IFACE" 2>/dev/null)
    ap=$(printf '%s' "$iw" | sed -n 's/.*Access Point: *\([^ ]*\).*/\1/p')
    sig=$(printf '%s' "$iw" | sed -n 's/.*Signal level=\([-0-9]*\).*/\1/p')
    printf 'ap=%s signal=%sdBm ps=%s' \
        "${ap:-unknown}" "${sig:-?}" \
        "$(printf '%s' "$iw" | grep -q 'Power Management:on' && echo on || echo off)"
}

associated() {
    /sbin/iwconfig "$IFACE" 2>/dev/null | grep -q 'Access Point: *[0-9A-Fa-f][0-9A-Fa-f]:'
}

# brcmfmac re-enables power save on (re)association, so re-assert rather than
# trusting the one-shot at boot.
powersave_off() {
    /sbin/iwconfig "$IFACE" 2>/dev/null | grep -q 'Power Management:on' || return 0
    /sbin/iwconfig "$IFACE" power off 2>/dev/null && say "re-asserted power_save off"
}

trim_log() {
    local n
    n=$(wc -l < "$EVENTLOG" 2>/dev/null || echo 0)
    [ "$n" -gt "$MAXLOG" ] || return 0
    tail -n $((MAXLOG / 2)) "$EVENTLOG" > "$EVENTLOG.tmp" 2>/dev/null &&
        mv "$EVENTLOG.tmp" "$EVENTLOG" 2>/dev/null
}

# ── connectivity probe ────────────────────────────────────────────────────────
GW=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')

if [ -n "$GW" ] && ping -c 2 -W 3 -I "$IFACE" "$GW" >/dev/null 2>&1; then
    FAILS=$(cat "$STATE" 2>/dev/null || echo 0)
    case "$FAILS" in ''|*[!0-9]*) FAILS=0 ;; esac
    if [ "$FAILS" -ge "$L1_REASSOC" ]; then
        say "RECOVERED after ${FAILS} failed checks ($(radio_state))"
        trim_log
    fi
    echo 0 > "$STATE"
    powersave_off
    exit 0
fi

# ── failure path ──────────────────────────────────────────────────────────────
FAILS=$(cat "$STATE" 2>/dev/null || echo 0)
case "$FAILS" in ''|*[!0-9]*) FAILS=0 ;; esac
FAILS=$((FAILS + 1))
echo "$FAILS" > "$STATE"

[ "$FAILS" -eq 1 ] && say "link check failed (gw=${GW:-none}, $(radio_state))"

case "$FAILS" in
    "$L1_REASSOC")
        say "L1: reassociating ($(radio_state))"
        powersave_off
        /sbin/wpa_cli -i "$IFACE" reassociate >/dev/null 2>&1
        sleep 5
        /sbin/dhcpcd -n "$IFACE" >/dev/null 2>&1
        ;;
    "$L2_IFACE")
        say "L2: bouncing $IFACE ($(radio_state))"
        ip link set "$IFACE" down 2>/dev/null
        sleep 3
        ip link set "$IFACE" up 2>/dev/null
        sleep 5
        systemctl restart wpa_supplicant >/dev/null 2>&1
        sleep 5
        /sbin/dhcpcd -n "$IFACE" >/dev/null 2>&1
        powersave_off
        ;;
    "$L3_MODULE")
        say "L3: reloading brcmfmac ($(radio_state))"
        /sbin/modprobe -r brcmfmac 2>/dev/null
        sleep 5
        /sbin/modprobe brcmfmac 2>/dev/null
        sleep 10
        systemctl restart wpa_supplicant >/dev/null 2>&1
        sleep 5
        /sbin/dhcpcd -n "$IFACE" >/dev/null 2>&1
        powersave_off
        ;;
esac

# ── L4: reboot, rate-limited ──────────────────────────────────────────────────
# A reboot drops RS485 for ~30 s and can trip a transient MODBUS40 alarm, and it
# does nothing at all when the fault is upstream (router down, power cut). So it
# is both the last resort and strictly rate-limited: if a reboot did not fix it,
# looping is worse than staying up and serving the heat pump until the AP is back.
if [ "$FAILS" -ge "$L4_REBOOT" ]; then
    NOW=$(date +%s)
    LAST=$(cat "$REBOOTSTAMP" 2>/dev/null || echo 0)
    case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac

    if [ $((NOW - LAST)) -lt "$REBOOT_COOLDOWN" ]; then
        # Only grumble once per escalation, not every minute.
        [ "$FAILS" -eq "$L4_REBOOT" ] &&
            say "L4 suppressed: rebooted $(( (NOW - LAST) / 60 )) min ago, cooldown active — fault likely upstream"
        exit 0
    fi

    if associated; then
        say "L4: REBOOT after ${FAILS} min offline (associated but no traffic, $(radio_state))"
    else
        say "L4: REBOOT after ${FAILS} min offline (not associated, $(radio_state))"
    fi
    echo "$NOW" > "$REBOOTSTAMP"
    trim_log
    sync
    systemctl reboot
fi

exit 0
