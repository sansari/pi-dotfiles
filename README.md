# pi-dotfiles

Personal [pi coding agent](https://pi.dev) configuration — extensions, settings, and skills.

## What's in here

```
~/.pi/agent/
├── extensions/
│   ├── communication-guidelines.ts  # Narrate before acting, ask on ambiguity
│   ├── todo.ts                      # Todo list tool
│   ├── changelog.ts                 # Changelog update tool
│   ├── supacode/                    # Supacode CLI integration
│   └── pi-web-agent/               # Web agent config (verbose mode)
├── settings.json                    # Theme, default model, installed packages
└── skills/                          # Global skills
```

## Fresh machine setup

```bash
# 1. Install pi
curl -fsSL https://pi.dev/install.sh | sh

# 2. Clone this repo into ~/.pi/agent
git clone <repo-url> ~/.pi/agent

# 3. Restore packages
pi install
```

## Packages

Packages listed in `settings.json` are not committed (installed to `npm/`).
Run `pi install` after cloning to restore them.
