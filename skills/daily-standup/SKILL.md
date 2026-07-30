---
name: daily-standup
description: Prepare a concise daily standup update from recent work, git history, TODOs, and current repo status. Use when the user asks for a standup, daily update, yesterday/today/blockers summary, or async status report.
---

# Daily Standup

Use this skill to produce a short, useful standup update for the current repo or working context.

## Workflow

1. Identify the repo/context.
   - Run `git status --short` when in a git repo.
   - Run `git branch --show-current` and `git log --oneline --decorate -n 10` for recent commits.
   - If helpful, inspect `TODO.md`, `CHANGELOG.md`, and recent plan/spec files.
   - Do not edit files unless explicitly asked.

2. Summarize recent completed work.
   - Prefer concrete merged/committed changes over vague activity.
   - Mention uncommitted work separately from committed/pushed work.

3. Summarize current focus / next work.
   - Pull from TODOs, failing checks, active branch context, and user-stated priorities.

4. Summarize blockers/risks.
   - Include failing tests/checks, review failures, unclear decisions, environment problems, or dependencies.
   - If there are no obvious blockers, say so plainly.

## Output format

Keep it concise and ready to paste into Slack/Linear/email:

```markdown
Standup — YYYY-MM-DD

Yesterday / recently:
- ...

Today / next:
- ...

Blockers / risks:
- ...
```

If the user asks for a more casual format, use:

```markdown
Yesterday: ...
Today: ...
Blockers: ...
```

## Guidelines

- Be factual; do not invent completed work.
- Mention command/check results only when relevant.
- Keep each bullet one line when possible.
- If the current repo has sensitive naming rules, follow them.
- If multiple repos are involved, group by repo.
