# Global Pi Agent Instructions

## Visual Verification

- Use Playwright to visually verify changes by inspecting them yourself on the relevant local server.
- Assume the local development server is already running separately unless proven otherwise; browse directly to the relevant local URL.
- Do NOT assume you cannot browse to a URL. You can browse to URLs and must use that ability for verification.
- Always test changes yourself first. However, if your changes require manual testing, offer to run a live interactive test, or suggest user verifies it themselves.
- Do NOT mark a task complete if it can be visually verified and you have not visually verified it. Visual verification is required before completion.
- After making CSS/HTML/layout/content-rendering changes, open the relevant page with Playwright, inspect the result, and confirm the change worked.
- Only report back to the user once you've verified the changes are correct.

### Native macOS apps (no browser available)

- Do not use a full-screen `screencapture` or a fixed `-R x,y,w,h` region — both capture whatever happens to be on top at that moment (other windows, terminal chrome, etc.), not reliably the app under test.
- Instead, resolve the target window's actual `CGWindowNumber` and capture that specific window regardless of stacking order:
  1. Write a tiny throwaway Swift script that calls `CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID)`, filters by `kCGWindowOwnerName` (the app name), and prints `kCGWindowNumber` (see `/tmp/winid.swift` pattern — recreate as needed, it's ~10 lines).
  2. Run it with `swift /tmp/winid.swift` to get the window id.
  3. Capture with `screencapture -x -o -l<windowid> /tmp/out.png` (`-o` omits the window shadow).
- This requires the user to have granted Screen Recording permission to the terminal/process pi is running in (System Settings → Privacy & Security → Screen Recording). If `screencapture` fails with "could not create image from display", ask the user to grant it rather than assuming screenshots are unavailable — it's a one-time grant, not a hard blocker.
- AppleScript via `System Events` (window bounds, activation, clicking) commonly hits `-1743 Not authorized to send Apple events` in this environment and individual apps rarely expose window bounds via their own default Standard Suite either — don't rely on it for locating windows; use the `CGWindowListCopyWindowInfo` approach above instead, which only needs Screen Recording permission, not Automation permission.
- Crop/zoom into a specific region of a captured screenshot with `ffmpeg -y -i in.png -vf "crop=W:H:X:Y" -frames:v 1 out.png` (note: needs `-frames:v 1`, plain `ffmpeg... crop... out.png` errors on a single still image without it).

## Communication

- Keep tool-step narration terse: one short sentence such as “Rebuilding and inspecting.” Avoid long status explanations unless the user asks for details.

## Reliable hooks and effects

- Never use an arbitrary delay, sleep, debounce, polling quiet period, or other timing heuristic as a substitute for an authoritative lifecycle or completion signal.
- Effects and hooks must attach to a documented, deterministic signal and preserve causal event ordering from the source through the handler.
- Timing may improve presentation or rate-limit work only after correctness is independent of the timing value.
- If no reliable signal exists, expose or build an explicit state transition, event, acknowledgment, or ordered pipeline before implementing the dependent effect.

## Development workflow

For non-trivial implementation work, complete the loop in this order before reporting completion:

1. Make the requested change.
2. Manually/visually verify the change yourself where applicable, following the Visual Verification rules above; if the change requires the user's manual verification, explicitly pause for that verification.
3. Review the implementation diff for correctness, architecture, race conditions, UI/UX regressions, error handling, and maintainability.
4. Ask a fresh-context reviewer/subagent to review the implementation diff when available.
5. Fix blocking review findings, or explicitly document why they are deferred.
6. Update and run relevant non-UI automated tests first: focused unit, integration, process/lifecycle, and requirements evidence tests.
7. Run UI automation tests only at the final pre-push stage, after non-UI automated tests pass and any required user manual verification is complete.
8. When preparing to push changes in a repository that uses 2119, run `npx rfc2119 check` immediately before the push.

The implementation review is separate from 2119 requirement/test review. After implementing a feature or fix, run its focused relevant non-UI tests to verify the change. Do not run UI automation suites during iterative implementation or review churn; reserve them for the final pre-push gate after unit/integration checks and required manual verification. For ordinary local tasks, do not mark the task complete until verification, review, and focused non-UI tests are done, or any blocker is clearly reported. Do not run the full `rfc2119 check` suite merely to finish an individual task; reserve it for the pre-push gate.

## Plans and specs

- When writing any plan, spec, requirements document, acceptance criteria, or test plan, keep the requirement set deliberately coarse for small UX/product features: prefer a handful of broad, observable requirements that match user-visible behavior over many narrowly sliced micro-requirements. Split a requirement only when the obligations are independently high-risk, independently observable, or require materially different test evidence; do not create separate requirements just because implementation has separate steps.
- Before treating a spec as ready, review whether it is appropriately coarse as well as outcome-stated and testable. If a feature that feels small needs many requirements, stop and ask whether the spec should be collapsed before implementation.
- Whenever you write or substantially revise a plan (milestone plans, implementation plans, specs, design docs, etc.), also generate a rendered HTML version of it and open it for the user to review, in addition to the markdown source.
- Prefer a small reusable markdown-to-HTML script/generator per project (check for an existing one, e.g. a `build-*-html.mjs`-style script, before writing a new one) over one-off throwaway conversions, so plans stay easy to regenerate as they're revised.
- After generating the HTML, open it (e.g. via `open <file>` on macOS) so it's actually visible, not just written to disk.
- If a project has its own conventions for where plans/specs live (e.g. a `plans/` directory) and its own naming/discipline rules (e.g. not naming third-party products), follow those conventions for both the markdown and the generated HTML.
