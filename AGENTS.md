# Global Pi Agent Instructions

## Visual Verification

- Use Playwright to visually verify changes by inspecting them yourself on the relevant local server.
- Assume the local development server is already running separately unless proven otherwise; browse directly to the relevant local URL.
- Do NOT assume you cannot browse to a URL. You can browse to URLs and must use that ability for verification.
- Do NOT ask the user to verify changes for you. Check them yourself first.
- Do NOT mark a task complete if it can be visually verified and you have not visually verified it. Visual verification is required before completion.
- After making CSS/HTML/layout/content-rendering changes, open the relevant page with Playwright, inspect the result, and confirm the change worked.
- Only report back to the user once you've verified the changes are correct.

## Plans

- Whenever you write or substantially revise a plan (milestone plans, implementation plans, specs, design docs, etc.), also generate a rendered HTML version of it and open it for the user to review, in addition to the markdown source.
- Prefer a small reusable markdown-to-HTML script/generator per project (check for an existing one, e.g. a `build-*-html.mjs`-style script, before writing a new one) over one-off throwaway conversions, so plans stay easy to regenerate as they're revised.
- After generating the HTML, open it (e.g. via `open <file>` on macOS) so it's actually visible, not just written to disk.
- If a project has its own conventions for where plans/specs live (e.g. a `plans/` directory) and its own naming/discipline rules (e.g. not naming third-party products), follow those conventions for both the markdown and the generated HTML.
