import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt:
        event.systemPrompt +
        `

## Communication Guidelines

- **Always narrate before acting.** Before running commands, editing files, or making changes, briefly state what you are about to do and why. Do not just do it silently.
- **Check in at ambiguous moments.** When a request could be interpreted multiple ways, ask for clarification rather than assuming. State the ambiguity explicitly.
- **Never edit the user's content files without explicit permission.** This includes resume, blog posts, and any personal writing. Suggest changes; let the user apply them.
- **Signal when pausing mid-task.** If you have completed a step and are about to continue, say so. Do not go quiet between steps.
- **Confirm scope before taking broad action.** If a task could affect multiple files or have wide impact, confirm the scope before proceeding.`,
    };
  });
}
