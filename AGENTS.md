# Global Pi Agent Instructions

## Visual Verification

- Verify visually inspectable changes yourself before reporting completion.
- For web UI, use Playwright and browse directly to the relevant local URL; assume local servers/browsing are available unless proven otherwise.
- For CSS/HTML/layout/rendering changes, inspect the changed page and confirm the result.
- If manual-only verification is required, pause and ask for it explicitly.

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
- When dispatching batched reviewer/subagent work, report progress between batches as `N/T complete, P pending, F failures so far`, with a short list of blocking failures.

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
- Use the global `code-reviewer` for risk-triggered independent review and mandatory 2119 review work.
- Use the active agent for direct implementation and ordinary conversation. The specialist model selection is owned by each agent definition, not the active session default.
