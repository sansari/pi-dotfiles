# pi-dotfiles

Personal [pi coding agent](https://pi.dev) configuration: global extensions,
agent profiles, settings, and maintenance scripts. Clone this repository to
`~/.pi/agent` to use it as your pi agent configuration directory.

## Features

| Extension | What it adds |
| --- | --- |
| `communication-guidelines.ts` | Prompts the agent to narrate actions, clarify ambiguity, and confirm broad scope. |
| `todo.ts` | A `todo` tool and `/todos` command for managing a project's `TODO.md`, including priorities and recently completed items. |
| `changelog.ts` | An `update_changelog` tool for date-based, user-facing changelog entries, plus a reminder when staged changes are committed or pushed without a changelog update. |
| `git.ts` | `/git` helpers for status, diffs, issues, pull, and push; `/start` creates an issue and worktree; `/ship` runs checks and guides a PR through merge and worktree cleanup. |
| `daily.ts` | `/daily` drafts a Slack-ready daily update from git history, `CHANGELOG.md`, and `TODO.md`, and copies it to the clipboard by default. |
| `html-report.ts` | An `html_report` tool and `/report` command that turn Markdown into a navigable HTML report. |
| `web.ts` | `web_search` and `web_fetch` tools for finding and reading online information. |
| `requirements-review/` | A review tool that runs agent tasks individually, in parallel, or in sequence using isolated pi processes. |
| `sync-config.ts` | `/sync-config` to pull, push, or inspect this global configuration repository; it also checks for updates at pi startup. |
| `orca-agent-status.ts`, `orca-prefill.ts`, `orca-titlebar-spinner.ts` | Optional Orca integration for reporting agent/session status, pre-filling the prompt, and indicating activity in the title bar. |

The `agents/` directory contains reusable agent profiles. `settings.json`
sets the default provider, model, thinking level, theme, and installed packages.
Package installations themselves live in the ignored `npm/` directory.

## Fresh machine setup

```bash
# 1. Install pi
curl -fsSL https://pi.dev/install.sh | sh

# 2. Clone this repo into pi's global agent directory
git clone <repo-url> ~/.pi/agent

# 3. Restore packages listed in settings.json
pi install

# 4. Optional: install the macOS orphaned-session maintenance job
./scripts/install-launchd-jobs.sh
```

## Syncing this configuration

From the repository directory, `sync-config.sh` supports:

```bash
./sync-config.sh status # Show branch and recent sync status
./sync-config.sh pull   # Fetch and fast-forward from the configured upstream
./sync-config.sh push   # Commit local changes and push to origin
```

Pull refuses to overwrite tracked local changes and only fast-forwards. Push
respects `.gitignore`, so machine-specific files such as credentials, sessions,
and installed packages are not added. The `/sync-config` extension command
provides the same operations in pi and offers to review or push local changes
when a startup pull is blocked. The repository needs a configured git upstream
for sync operations.

## Maintenance: orphaned session reaper

`pi` CLI sessions are normal foreground processes attached to a terminal. If
the terminal goes away without the process exiting cleanly (crashed shell,
force-closed window, dropped SSH connection, ...), the `pi` process can keep
running in the background indefinitely, unreachable, quietly holding memory.

`scripts/reap-orphaned-pi-sessions.sh` finds `pi` processes with **no
controlling terminal** (`ps` TTY `??`) that have been running for at least 5
minutes, and kills only those — it never touches a `pi` process still
attached to a real terminal, no matter how long it's been running.
`launchd/com.sansari.pi-reap-orphaned-sessions.plist` runs it automatically
every 15 minutes via `launchd` once installed with
`scripts/install-launchd-jobs.sh`. Kills are logged to
`scripts/reap-orphaned-pi-sessions.log`.
