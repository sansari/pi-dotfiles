#!/usr/bin/env bash
# reap-orphaned-pi-sessions.sh — kill `pi` CLI processes that have become
# detached from any controlling terminal.
#
# Background: pi CLI sessions are normal foreground processes attached to a
# terminal (Terminal.app tab, tmux pane, embedded terminal, etc). If the
# terminal that launched one goes away without the process exiting cleanly
# (crashed shell, force-closed window, disconnected SSH session, ...), the
# `pi` process can be left running in the background indefinitely — showing
# up in `ps` with TTY `??` — quietly holding memory/CPU with no way for the
# user to interact with it again.
#
# This script only ever targets processes that meet ALL of:
#   1. Command name is exactly `pi` (the CLI entry point, not e.g. Xcode's
#      PiNative.app or unrelated commands that happen to contain "pi").
#   2. TTY is `??` (no controlling terminal — i.e. provably unreachable by
#      the user, not just "a session you haven't looked at in a while").
#   3. Process start time is at least $MIN_AGE_MINUTES ago, so a process
#      that hasn't attached its tty yet in the first instant of startup
#      can't be mistaken for orphaned.
#
# It never touches processes still attached to a real tty, no matter how
# long they've been running — those may be legitimate long-lived sessions.
#
# Usage: reap-orphaned-pi-sessions.sh [--dry-run]

set -euo pipefail

MIN_AGE_MINUTES=5
LOG_FILE="$HOME/.pi/agent/scripts/reap-orphaned-pi-sessions.log"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# Converts BSD `ps -o etime=` output (`[[dd-]hh:]mm:ss`) to whole seconds.
etime_to_seconds() {
    local etime="$1" days=0 hms rest
    if [[ "$etime" == *-* ]]; then
        days="${etime%%-*}"
        rest="${etime#*-}"
    else
        rest="$etime"
    fi
    local IFS=:
    read -ra parts <<<"$rest"
    local h=0 m=0 s=0
    case "${#parts[@]}" in
        3) h="${parts[0]}"; m="${parts[1]}"; s="${parts[2]}" ;;
        2) m="${parts[0]}"; s="${parts[1]}" ;;
        1) s="${parts[0]}" ;;
    esac
    echo $(( ((10#$days * 24 + 10#$h) * 60 + 10#$m) * 60 + 10#$s ))
}

while IFS= read -r line; do
    pid=$(awk '{print $1}' <<<"$line")
    tty=$(awk '{print $2}' <<<"$line")
    etime=$(awk '{print $3}' <<<"$line")
    comm=$(awk '{print $4}' <<<"$line")

    [[ "$comm" == "pi" ]] || continue
    [[ "$tty" == "??" ]] || continue

    seconds=$(etime_to_seconds "$etime")
    (( seconds >= MIN_AGE_MINUTES * 60 )) || continue

    entry="$(date '+%Y-%m-%d %H:%M:%S') killing orphaned pi pid=$pid etime=${etime} (no controlling tty)"
    if [[ "$DRY_RUN" == "1" ]]; then
        echo "[dry-run] $entry"
    else
        echo "$entry" >>"$LOG_FILE"
        kill "$pid" 2>/dev/null || true
    fi
done < <(ps -axo pid=,tty=,etime=,comm= | awk '{$1=$1};1')

exit 0
