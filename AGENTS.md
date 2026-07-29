# Global Pi Agent Instructions

## Visual Verification

- Use Playwright to visually verify changes by inspecting them yourself on the relevant local server.
- Assume the local development server is already running separately unless proven otherwise; browse directly to the relevant local URL.
- Do NOT assume you cannot browse to a URL. You can browse to URLs and must use that ability for verification.
- Do NOT ask the user to verify changes for you. Check them yourself first.
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

## Independent implementation review

After making non-trivial implementation changes, perform an independent fresh-context code review before reporting completion.

This is separate from 2119 requirement/test review. The review must inspect the implementation diff for correctness, architecture, race conditions, UI/UX regressions, error handling, and maintainability.

Workflow:
1. Finish implementation and local tests.
2. Review the relevant diff.
3. Ask a fresh-context reviewer/subagent to review the implementation diff.
4. Fix blocking findings or explicitly document why they are deferred.
5. Do not call the task complete until this review is done.

## Plans

- Whenever you write or substantially revise a plan (milestone plans, implementation plans, specs, design docs, etc.), also generate a rendered HTML version of it and open it for the user to review, in addition to the markdown source.
- Prefer a small reusable markdown-to-HTML script/generator per project (check for an existing one, e.g. a `build-*-html.mjs`-style script, before writing a new one) over one-off throwaway conversions, so plans stay easy to regenerate as they're revised.
- After generating the HTML, open it (e.g. via `open <file>` on macOS) so it's actually visible, not just written to disk.
- If a project has its own conventions for where plans/specs live (e.g. a `plans/` directory) and its own naming/discipline rules (e.g. not naming third-party products), follow those conventions for both the markdown and the generated HTML.
