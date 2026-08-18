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

For non-trivial implementation work, complete the loop in this order before reporting completion:

1. Make the requested change.
2. Manually/visually verify the change yourself where applicable, following the Visual Verification rules above; if the change requires the user's manual verification, explicitly pause for that verification.
3. Review the implementation diff for correctness, architecture, race conditions, UI/UX regressions, error handling, and maintainability.
4. Ask a fresh-context reviewer/subagent to review the implementation diff when available.
5. Fix blocking review findings, or explicitly document why they are deferred.
6. Update and run relevant non-UI automated tests first: focused unit, integration, process/lifecycle, and requirements evidence tests. When running unit tests, use a 60-second timeout by default unless the user explicitly authorizes a longer run, and provide visible progress/feedback while the tests run rather than going silent.
7. Run UI automation tests only at the final pre-push stage, after non-UI automated tests pass and any required user manual verification is complete.
8. When preparing to push changes in a repository that uses 2119, run `npx rfc2119 check` immediately before the push.

The implementation review is separate from 2119 requirement/test review. After implementing a feature or fix, run its focused relevant non-UI tests to verify the change. Unit-test runs should default to a 60-second timeout and should stream or periodically summarize visible progress; if a test run hits the timeout, stop immediately, inspect the hang/failure, and report the blocker instead of rerunning with a longer timeout without permission. Do not run UI automation suites during iterative implementation or review churn; reserve them for the final pre-push gate after unit/integration checks and required manual verification. For ordinary local tasks, do not mark the task complete until verification, review, and focused non-UI tests are done, or any blocker is clearly reported. Do not run the full `rfc2119 check` suite merely to finish an individual task; reserve it for the pre-push gate.

## Plans and specs

- Keep small UX/product specs coarse: broad, observable requirements; split only when risks/evidence differ materially.
- Before treating a spec as ready, check that requirements are outcome-stated, testable, and not over-sliced.
- When writing or substantially revising plans/specs/design docs, generate and open an HTML version; prefer a reusable project generator when one exists.
- Follow project conventions for locations and naming restrictions.

## Specialist Subagent Routing

- Delegate planning, research, and substantial report-generation work to the global `planner` subagent.
- Delegate implementation/code reviews to the global `code-reviewer` subagent. Do not review your own implementation in the same context when this specialist is available.
- Use the active agent for direct implementation and ordinary conversation. The specialist model selection is owned by each agent definition, not the active session default.
