#!/bin/bash
# NibePi time sync
#
# Replaces ntpd, which could not be made to work on this box: it listened fine
# and had -g, but never established a single pool association (reach 0 for every
# peer), so the clock silently sat 23 minutes out. ntpd also cannot persist its
# drift file on a read-only root.
#
# The failure mode that matters: /etc/fake-hwclock.data cannot be written while
# root is ro, so every boot restores a stale timestamp. Something must force a
# correction afterwards, and it must cope with an arbitrarily large offset --
# ntpd refuses to step past its 1000 s panic threshold, sntp -S does not care.
#
# Correct time is not cosmetic here: it timestamps the netwatch incident log,
# which is the only forensic record that survives a reboot.

# Prefer the LAN gateway (answers even when the WAN is down), fall back to pool.
GW=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')

for SRV in "$GW" pool.ntp.org; do
    [ -n "$SRV" ] || continue
    # sntp warns it cannot write its KOD db on a ro root; harmless, so drop it.
    # systemd captures stdout into the journal; logger is useless here because
    # nothing serves /dev/log on this box (rsyslog is inactive).
    if sntp -S "$SRV" 2>/dev/null | grep -q .; then
        echo "clock stepped from $SRV"
        exit 0
    fi
done

echo "no time source reachable"
exit 0
