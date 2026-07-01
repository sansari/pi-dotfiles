#!/usr/bin/env bash
# sync-config.sh — sync ~/.pi/agent (this repo) with its git remote.
#
# Usage:
#   ./sync-config.sh            same as "pull"
#   ./sync-config.sh pull       fetch + fast-forward pull from origin
#   ./sync-config.sh push       commit any local changes and push to origin
#   ./sync-config.sh status     show current sync status, no changes made
#
# Designed to be safe to run unattended for `pull`/`status`: it never
# force-pushes, never force-overwrites local changes, and never rewrites
# history. `push` only commits/pushes files already tracked or newly added
# (respecting .gitignore) — it will not touch gitignored machine-specific
# files like auth.json, trust.json, sessions/, npm/, git/, bin/, models.json.

set -euo pipefail

# Resolve to this script's own directory so it works regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: $SCRIPT_DIR is not a git repository" >&2
  exit 1
fi

mode="${1:-pull}"

branch="$(git rev-parse --abbrev-ref HEAD)"
upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"

if [[ -z "$upstream" ]]; then
  echo "error: branch '$branch' has no upstream configured" >&2
  exit 1
fi

is_dirty() {
  [[ -n "$(git status --porcelain --untracked-files=no)" ]]
}

case "$mode" in
  status)
    echo "branch: $branch -> $upstream"
    git status -sb
    echo
    echo "recent commits:"
    git log --oneline -5
    ;;

  pull)
    if is_dirty; then
      echo "error: local changes present in tracked files — commit or run './sync-config.sh push' first, then pull again." >&2
      git status -s >&2
      exit 1
    fi

    before="$(git rev-parse HEAD)"
    git fetch origin --quiet

    if ! git merge --ff-only "$upstream" --quiet 2>/tmp/sync-config-merge-err; then
      echo "error: cannot fast-forward — local and remote have diverged. Resolve manually." >&2
      cat /tmp/sync-config-merge-err >&2
      exit 1
    fi

    after="$(git rev-parse HEAD)"
    if [[ "$before" == "$after" ]]; then
      echo "already up to date."
    else
      echo "updated $branch: $(git rev-parse --short "$before")..$(git rev-parse --short "$after")"
      echo
      echo "changed files:"
      git diff --name-status "$before" "$after"
      echo
      echo "new commits:"
      git log --oneline "$before..$after"
    fi
    ;;

  push)
    git add -A
    if git diff --cached --quiet; then
      echo "nothing to sync — working tree matches last commit."
      exit 0
    fi

    summary="$(git diff --cached --stat | tail -1)"
    git commit --quiet -m "sync-config: update from $(hostname -s 2>/dev/null || hostname)"
    git push origin "$branch" --quiet
    echo "pushed: $summary"
    git log --oneline -1
    ;;

  *)
    echo "usage: $0 [pull|push|status]" >&2
    exit 1
    ;;
esac
