import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
type LocalChangesChoice = "push" | "clear" | "ignore" | "diff";

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

async function dirtySummary(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "-s"], { cwd: REPO_ROOT, timeout: 10_000 });
  return stdout.trim();
}

async function localDiff(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["diff", "--color=always", "--", "."], { cwd: REPO_ROOT, timeout: 10_000 });
  return stdout.trim() || "no tracked file diff";
}

async function clearLocalChanges(): Promise<{ ok: boolean; output: string }> {
  try {
    const before = await dirtySummary();
    await execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd: REPO_ROOT, timeout: 10_000 });
    return { ok: true, output: before || "no local changes" };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim() || err.message || String(error);
    return { ok: false, output };
  }
}

async function chooseLocalChangesAction(ctx: ExtensionContext, summary: string): Promise<LocalChangesChoice | undefined> {
  const choice = await ctx.ui.select(
    `~/.pi/agent has local changes that must be handled before pulling:\n\n${summary}`,
    ["Push to remote", "Show changes", "Reset local"],
  );

  if (choice === "Push to remote") return "push";
  if (choice === "Show changes") return "diff";
  if (choice === "Reset local") return "clear";
  return undefined;
}

/// Runs once per real `pi` process launch (reason "startup" only — not for
/// every `/new`/`/resume`/`/fork` within an already-running process, which
/// would otherwise pop confirmation dialogs far too often). Order matches
/// the agreed product behavior: try a pull first; only if it fails because
/// of local uncommitted changes do we offer to push (with confirmation,
/// always) and then retry the pull. Any other pull failure (no network,
/// diverged history, ...) is just surfaced — never auto-escalated to a push.
async function autoSyncOnStartup(ctx: ExtensionContext, onUpdated?: () => Promise<void>): Promise<void> {
  const STATUS_KEY = "sync-config";
  ctx.ui.setStatus(STATUS_KEY, "Syncing your global pi config…");

  try {
    const pull = await runSync("pull");

    if (pull.ok) {
      if (!pull.output.startsWith("already up to date")) {
        ctx.ui.notify(`Global pi config updated:\n${truncate(pull.output)}`, "info");
        await onUpdated?.();
      }
      return;
    }

    if (!pull.output.includes("local changes present")) {
      ctx.ui.notify(`Syncing your global pi config failed:\n${truncate(pull.output)}`, "error");
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, "Global pi config has local changes…");
    const summary = await dirtySummary();
    let choice = await chooseLocalChangesAction(ctx, summary);
    while (choice === "diff") {
      ctx.ui.notify(`Local pi config diff:\n${truncate(await localDiff(), 80)}`, "info");
      choice = await chooseLocalChangesAction(ctx, summary);
    }

    if (!choice || choice === "ignore") {
      ctx.ui.notify("sync-config: ignored local changes and continued without syncing. Run /sync-config when ready.", "info");
      return;
    }

    if (choice === "push") {
      ctx.ui.setStatus(STATUS_KEY, "Pushing your global pi config…");
      const push = await runSync("push");
      if (!push.ok) {
        ctx.ui.notify(`Pushing your global pi config failed:\n${truncate(push.output)}`, "error");
        return;
      }
      ctx.ui.notify(`Global pi config pushed:\n${truncate(push.output)}`, "info");
    } else {
      ctx.ui.setStatus(STATUS_KEY, "Clearing local pi config changes…");
      const clear = await clearLocalChanges();
      if (!clear.ok) {
        ctx.ui.notify(`Clearing your local pi config changes failed:\n${truncate(clear.output)}`, "error");
        return;
      }
      ctx.ui.notify(`Cleared local pi config changes:\n${truncate(clear.output)}`, "info");
    }

    ctx.ui.setStatus(STATUS_KEY, "Syncing your global pi config…");
    const retryPull = await runSync("pull");
    if (!retryPull.ok) {
      ctx.ui.notify(`Syncing your global pi config failed:\n${truncate(retryPull.output)}`, "error");
      return;
    }
    if (!retryPull.output.startsWith("already up to date")) {
      ctx.ui.notify(`Global pi config updated:\n${truncate(retryPull.output)}`, "info");
      await onUpdated?.();
    }
  } finally {
    ctx.ui.setStatus(STATUS_KEY, "");
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    await autoSyncOnStartup(ctx);
  });

  pi.registerCommand("sync-config", {
    description: "Sync ~/.pi/agent with its git remote (pull|push|status, default: pull)",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const mode: Mode = arg === "push" || arg === "status" ? arg : "pull";

      ctx.ui.setStatus("sync-config", `sync-config: running ${mode}…`);
      if (mode === "pull") {
        await autoSyncOnStartup(ctx, async () => {
          await ctx.reload();
        });
        return;
      }

      const result = await runSync(mode);
      ctx.ui.setStatus("sync-config", "");

      if (!result.ok) {
        ctx.ui.notify(`sync-config ${mode} failed:\n${truncate(result.output)}`, "error");
        return;
      }

      ctx.ui.notify(`sync-config ${mode}:\n${truncate(result.output)}`, "info");
    },
  });
}
