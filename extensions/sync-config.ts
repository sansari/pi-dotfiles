import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// This extension lives at ~/.pi/agent/extensions/sync-config.ts, so the repo
// root (where sync-config.sh lives) is always one directory up, regardless
// of where $HOME actually points on a given machine.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT_PATH = join(REPO_ROOT, "sync-config.sh");

type Mode = "pull" | "push" | "status";

async function runSync(mode: Mode): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout } = await execFileAsync(SCRIPT_PATH, [mode], {
      cwd: REPO_ROOT,
      timeout: 30_000,
    });
    return { ok: true, output: stdout.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim() || err.message || String(error);
    return { ok: false, output };
  }
}

function truncate(text: string, maxLines = 25): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines, see terminal)`].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sync-config", {
    description: "Sync ~/.pi/agent with its git remote (pull|push|status, default: pull)",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const mode: Mode = arg === "push" || arg === "status" ? arg : "pull";

      ctx.ui.setStatus("sync-config", `sync-config: running ${mode}…`);
      const result = await runSync(mode);
      ctx.ui.setStatus("sync-config", "");

      if (!result.ok) {
        ctx.ui.notify(`sync-config ${mode} failed:\n${truncate(result.output)}`, "error");
        return;
      }

      ctx.ui.notify(`sync-config ${mode}:\n${truncate(result.output)}`, "info");

      // If the pull actually brought in new commits (i.e. output isn't just
      // "already up to date."), reload extensions/skills/prompts/themes so
      // the update takes effect in this session immediately.
      if (mode === "pull" && !result.output.startsWith("already up to date")) {
        ctx.ui.notify("Reloading extensions/skills/prompts/themes…", "info");
        await ctx.reload();
        return;
      }
    },
  });
}
