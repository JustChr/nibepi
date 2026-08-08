#!/bin/bash
# NibePi network watchdog
#
# The hardware watchdog (RuntimeWatchdogSec) only catches a hung kernel. A Pi
# Zero W whose wlan0 silently drops association keeps the kernel perfectly
# healthy — systemd keeps petting the watchdog while the box is unreachable and
# the RS485 loop keeps the heat pump happy. That blind spot is what this closes.
#
# Run every minute by nibepi-netwatch.timer. Escalates gently, and records what
# it saw to the boot partition so the next outage leaves evidence behind
# (/var/log is tmpfs, so anything logged there dies with the reboot that fixes
# the problem).

IFACE=wlan0
STATE=/run/nibepi-netwatch.fails      # tmpfs: resets at boot, no SD wear

# Bookworm moved the FAT partition to /boot/firmware; Bullseye used /boot.
if [ -d /boot/firmware ]; then BOOTDIR=/boot/firmware; else BOOTDIR=/boot; fi
EVENTLOG="$BOOTDIR/nibepi-netwatch.log"
REBOOTSTAMP="$BOOTDIR/nibepi-netwatch.reboot"

REBOOT_COOLDOWN=21600                  # 6 h between watchdog reboots
MAXLOG=250                             # trim event log beyond this many lines
HEARTBEAT=60                           # during a long outage, log once an hour

# Escalation thresholds, in consecutive failed minutes
L1_REASSOC=3
L2_IFACE=6
L3_MODULE=10
L4_REBOOT=15

# Trixie drives wifi through NetworkManager; wpa_cli/dhcpcd still exist as
# binaries but no longer control the link, so the recovery actions must differ.
if systemctl is-active --quiet NetworkManager; then STACK=nm; else STACK=legacy; fi

say() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$EVENTLOG" 2>/dev/null
    # stdout, not logger: nothing serves /dev/log on some images (rsyslog
    # inactive), but systemd captures a oneshot service's stdout into the journal.
    echo "$*"
}

# Radio state at the moment of trouble — the diagnostics we wished we had.
# Prefer iw; fall back to iwconfig on images that lack it.
radio_state() {
    local out ap sig ps
    if command -v iw >/dev/null 2>&1 || [ -x /sbin/iw ]; then
        out=$(/sbin/iw dev "$IFACE" link 2>/dev/null)
        if printf '%s' "$out" | grep -q '^Connected to'; then
            ap=$(printf '%s'  "$out" | sed -n 's/^Connected to \([0-9a-fA-F:]*\).*/\1/p')
            sig=$(printf '%s' "$out" | sed -n 's/.*signal: *\(-\{0,1\}[0-9]*\).*/\1/p')
        else
            ap=Not-Associated
        fi
        ps=$(/sbin/iw dev "$IFACE" get power_save 2>/dev/null | sed -n 's/.*[Pp]ower save: *\([A-Za-z]*\).*/\1/p')
    else
        out=$(/sbin/iwconfig "$IFACE" 2>/dev/null)
        ap=$(printf '%s'  "$out" | sed -n 's/.*Access Point: *\([^ ]*\).*/\1/p')
        sig=$(printf '%s' "$out" | sed -n 's/.*Signal level=\(-\{0,1\}[0-9]*\).*/\1/p')
        ps=$(printf '%s' "$out" | grep -q 'Power Management:on' && echo on || echo off)
    fi
    printf 'ap=%s signal=%sdBm ps=%s' "${ap:-unknown}" "${sig:-?}" "${ps:-?}"
}

associated() {
    if [ -x /sbin/iw ]; then
        /sbin/iw dev "$IFACE" link 2>/dev/null | grep -q '^Connected to'
    else
        /sbin/iwconfig "$IFACE" 2>/dev/null | grep -q 'Access Point: *[0-9A-Fa-f][0-9A-Fa-f]:'
    fi
}

# The driver re-enables power save on (re)association, so re-assert rather than
# trusting the one-shot at boot / the NetworkManager default.
powersave_off() {
    if [ -x /sbin/iw ]; then
        /sbin/iw dev "$IFACE" get power_save 2>/dev/null | grep -qi 'power save: on' || return 0
        /sbin/iw dev "$IFACE" set power_save off 2>/dev/null && say "re-asserted power_save off"
    else
        /sbin/iwconfig "$IFACE" 2>/dev/null | grep -q 'Power Management:on' || return 0
        /sbin/iwconfig "$IFACE" power off 2>/dev/null && say "re-asserted power_save off"
    fi
}

wifi_conn() {   # name of the wifi connection profile, if any
    nmcli -t -f NAME,TYPE connection show 2>/dev/null \
        | grep '802-11-wireless' | cut -d: -f1 | head -1
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

[ "$FAILS" -eq 1 ] && say "link check failed (gw=${GW:-none}, stack=$STACK, $(radio_state))"

case "$FAILS" in
    "$L1_REASSOC")
        say "L1: reassociating ($(radio_state))"
        powersave_off
        if [ "$STACK" = nm ]; then
            nmcli device disconnect "$IFACE" >/dev/null 2>&1
            sleep 3
            nmcli device connect "$IFACE" >/dev/null 2>&1
        else
            /sbin/wpa_cli -i "$IFACE" reassociate >/dev/null 2>&1
            sleep 5
            /sbin/dhcpcd -n "$IFACE" >/dev/null 2>&1
        fi
        ;;
    "$L2_IFACE")
        say "L2: restarting network stack ($(radio_state))"
        if [ "$STACK" = nm ]; then
            systemctl restart NetworkManager >/dev/null 2>&1
            sleep 10
            CONN=$(wifi_conn)
            [ -n "$CONN" ] && nmcli connection up "$CONN" >/dev/null 2>&1
        else
            ip link set "$IFACE" down 2>/dev/null
            sleep 3
            ip link set "$IFACE" up 2>/dev/null
            sleep 5
            systemctl restart wpa_supplicant >/dev/null 2>&1
            sleep 5
            /sbin/dhcpcd -n "$IFACE" >/dev/null 2>&1
        fi
        powersave_off
        ;;
    "$L3_MODULE")
        say "L3: reloading brcmfmac ($(radio_state))"
        /sbin/modprobe -r brcmfmac 2>/dev/null
        sleep 5
        /sbin/modprobe brcmfmac 2>/dev/null
        sleep 10
        if [ "$STACK" = nm ]; then
            systemctl restart NetworkManager >/dev/null 2>&1
        else
            systemctl restart wpa_supplicant >/dev/null 2>&1
            sleep 5
            /sbin/dhcpcd -n "$IFACE" >/dev/null 2>&1
        fi
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
        # Grumble once per escalation, then a heartbeat each hour so a long
        # outage still leaves a trace of how long it actually lasted.
        if [ "$FAILS" -eq "$L4_REBOOT" ]; then
            say "L4 suppressed: rebooted $(( (NOW - LAST) / 60 )) min ago, cooldown active — fault likely upstream"
        elif [ $((FAILS % HEARTBEAT)) -eq 0 ]; then
            say "still offline after ${FAILS} min ($(radio_state))"
            trim_log
        fi
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
