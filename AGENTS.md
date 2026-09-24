# Global Pi Agent Instructions

## Visual Verification

- Verify visually inspectable changes yourself before reporting completion.
- For web UI, use Playwright and browse directly to the relevant local URL; assume local servers/browsing are available unless proven otherwise.
- For CSS/HTML/layout/rendering changes, inspect the changed page and confirm the result.
- If manual-only verification is required, pause and ask for it explicitly.
- When a user names a pasted screenshot without a path, look in `~/Screenshots/` first.

### Native macOS apps (no browser available)

- Capture the target app window by `CGWindowNumber`, not full-screen or fixed-region screenshots.
- Find the window id with `CGWindowListCopyWindowInfo`, then run `screencapture -x -o -l<windowid> /tmp/out.png`.
- If Screen Recording permission blocks capture, ask the user to grant it; crop/zoom with `ffmpeg ... -frames:v 1` when needed.

## UI theme colors

- Reuse platform semantic colors and the project's existing centralized theme tokens instead of embedding raw color values in feature views or components.
- When no existing color token expresses the intended semantic role, extend the centralized theme first, then reference that token from the feature code.
- UI automation should verify that elements appear and user-visible behaviors work, not assert exact colors, pixel values, opacities, or other visual styling. Evaluate visual polish through direct visual inspection instead of brittle UI-test thresholds.

## Communication

- Keep tool-step narration terse: one short sentence such as “Rebuilding and inspecting.” Avoid long status explanations unless the user asks for details.
- When dispatching batched reviewer/subagent work (including `code-reviewer`, `requirements-reviewer`, and `requirements_review` runs with more than one task), report results as a compact per-item status list — one line per reviewer/task with its id, pass/fail/pending status, and a one-sentence summary — instead of pasting each subagent's full narrative output. Follow the list with `N/T complete, P pending, F failures so far` and a short list of blocking failures. Offer full per-item detail only if the user asks.

## Report output locations

- When calling `html_report`, write output under a system temp directory (e.g. `/tmp` or `mktemp -d`), never into a project's `research/`, `reports/`, or other tracked/gitignored-but-committable directory, unless the user explicitly asks for a repo-tracked report location.

## GitHub access

- Always use the GitHub CLI (`gh`) to read, search, or modify GitHub resources; never use `web_fetch` or other browser/web-fetch tools for GitHub URLs.

## Reliable hooks and effects

- Never use delay/sleep/debounce/polling as a substitute for an authoritative lifecycle or completion signal.
- Effects must attach to deterministic signals and preserve source event ordering.
- Timing may only improve presentation/rate-limiting after correctness is independent of it.
- If no reliable signal exists, build an explicit state transition, event, acknowledgment, or ordered pipeline first.

## Development workflow

For non-trivial implementation work:

1. Implement the scoped change, then self-review the stable diff for requirements, correctness, error paths, lifecycle/races, regressions, and test evidence.
2. Request a fresh-context `code-reviewer` only for security/privacy, persistence or data-loss risk, concurrency/process/session lifecycle, public APIs/protocols, shared architecture, substantial refactors, inadequate evidence/uncertainty, or when the user asks.
3. Run focused non-UI tests first (60-second default for unit tests). A required review may run in parallel once the diff is stable; fix blockers and rerun affected tests.
4. Visually verify directly affected UI. Run UI automation only at the final pre-push stage.
5. For 2119 work, fresh-context spec critique and test-honesty review remain mandatory; run `npx rfc2119 check` immediately before pushing.

## Commits

With explicit user authorization for the branch or a defined cadence, create small, coherent commits after verified milestones. Before each commit, review staged changes and exclude unrelated, generated, secret, or user-owned content. Never amend, rebase, merge, or push without explicit authorization.

## Plans and specs

- Keep small UX/product specs coarse: broad, observable requirements; split only when risks/evidence differ materially.
- Before treating a spec as ready, check that requirements are outcome-stated, testable, and not over-sliced.
- When writing or substantially revising plans/specs/design docs, generate and open an HTML version; prefer a reusable project generator when one exists.
- Follow project conventions for locations and naming restrictions.

## Specialist Subagent Routing

- Delegate planning, research, and substantial report-generation work to the global `planner` subagent.
- Use the global `code-reviewer` for risk-triggered independent code review.
- Use the global `requirements-reviewer` for fresh-context 2119 specification critiques and test-honesty judgment reviews; batch independent judgment files through `requirements_review`.
- Use the active agent for direct implementation and ordinary conversation. The specialist model selection is owned by each agent definition, not the active session default.

## Roughdraft

Use Roughdraft when the user wants to review or comment on a Markdown file.

The user may refer to Roughdraft as `rd` in natural language. Treat `rd` as shorthand for Roughdraft in user requests, but do not create or modify any shell alias, executable, symlink, or command named `rd`.

When the user asks for a plan, write the plan as a Markdown file on disk before asking them to review it.

When you write or modify a Markdown file and want the user to review or comment on it, open it with:

```bash
roughdraft open "/absolute/path/to/file.md"
```

Roughdraft is currently a single-file Markdown viewer/editor. Open one `.md` file at a time.

If Roughdraft is not running, `roughdraft open` will start it automatically.

After `roughdraft open` opens the document, leave the command running. Do not interrupt, kill, background, detach, or treat the waiting process as cleanup. The wait is intentional: Roughdraft will exit the command after the user clicks Done Reviewing, and that exit is your signal to resume.

After the user finishes reviewing in Roughdraft, read the Markdown file from disk and respond to any CriticMarkup comments or suggested changes. If the user left questions or comments in the document, reply inline in the Markdown file using Roughdraft-flavored CriticMarkup, save it, and open the file in Roughdraft again so the user can continue reviewing.

Use Roughdraft-flavored CriticMarkup when reading or writing inline review feedback in Markdown. The base markers are:

Comment: `{>>comment<<}`
Insertion: `{++new text++}`
Deletion: `{--old text--}`
Substitution: `{~~old text~>new text~~}`
Highlight: `{==text==}`

When you add a new comment or suggested change, use the extended Roughdraft format with a compact inline reference such as `{#c1}` or `{#s1}`, then add metadata in final YAML endmatter. Generate a stable document-local id (`c1`, `c2`, etc. for comments; `s1`, `s2`, etc. for suggestions), set `by` to your agent or author label, set `at` to the current ISO timestamp, and set `re` when replying to an existing comment or suggestion.

Roughdraft may already have inline attribute blocks after comments and suggestions from older documents. Preserve those attributes unless you are intentionally removing the associated comment or suggestion. For new feedback, prefer compact references plus YAML endmatter.

Anchored comments usually look like `{==selected text==}{>>Comment text<<}{#c1}`. Suggested changes usually look like `{++new text++}{#s1}` or `{~~old text~>new text~~}{#s2}`. Replies live in final YAML endmatter with a `body` and `re` pointer.

Example:

```markdown
{==selected text==}{>>Comment text<<}{#c1}
{++new text++}{#s1}

---
comments:
  c1:
    by: AI
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can make that edit.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:10:00.000Z"
```

Use `roughdraft help` and `roughdraft help criticmarkup` for local command and syntax details.
