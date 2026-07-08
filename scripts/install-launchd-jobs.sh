#!/usr/bin/env bash
# install-launchd-jobs.sh — install this repo's launchd/*.plist agents into
# ~/Library/LaunchAgents and (re)load them. Safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

mkdir -p "$LAUNCH_AGENTS_DIR"

for plist in "$REPO_DIR"/launchd/*.plist; do
    label="$(basename "$plist" .plist)"
    dest="$LAUNCH_AGENTS_DIR/$label.plist"

    launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    cp "$plist" "$dest"
    launchctl bootstrap "gui/$(id -u)" "$dest"
    echo "installed + loaded: $label"
done
