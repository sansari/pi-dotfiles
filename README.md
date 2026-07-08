# pi-dotfiles

Personal [pi coding agent](https://pi.dev) configuration — extensions, settings, and skills.

## What's in here

```
~/.pi/agent/
├── extensions/
│   ├── communication-guidelines.ts  # Narrate before acting, ask on ambiguity
│   ├── todo.ts                      # Todo list tool
│   ├── changelog.ts                 # Changelog update tool
│   ├── html-report.ts               # html_report tool + /report command
│   ├── web.ts                       # web_search / web_fetch tools
│   ├── supacode/                    # Supacode CLI integration
│   └── pi-web-agent/               # Web agent config (verbose mode)
├── settings.json                    # Theme, default model, installed packages
├── skills/                          # Global skills
├── scripts/                         # Maintenance scripts (see below)
└── launchd/                         # macOS LaunchAgents for the scripts above
```

## Fresh machine setup

```bash
# 1. Install pi
curl -fsSL https://pi.dev/install.sh | sh

# 2. Clone this repo into ~/.pi/agent
git clone <repo-url> ~/.pi/agent

# 3. Restore packages
pi install

# 4. Install maintenance LaunchAgents (currently: orphaned-session reaper)
./scripts/install-launchd-jobs.sh
```

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

## Packages

Packages listed in `settings.json` are not committed (installed to `npm/`).
Run `pi install` after cloning to restore them.
