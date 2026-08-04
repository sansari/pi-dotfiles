import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ChangelogCategory = "Added" | "Changed" | "Fixed" | "Removed";

type GitOutputDetails = {
  title: string;
  kind: "status" | "diff" | "push" | "error";
};

async function runGit(cwd: string, args: string[], maxBuffer = 1024 * 1024 * 16): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer });
    return String(stdout ?? "").trim();
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    throw new Error(output || err.message || `git ${args.join(" ")} failed`);
  }
}

async function repoRoot(cwd: string): Promise<string> {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

function truncate(text: string, maxLines = 240): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`].join("\n");
}

function changedFilesFromStatus(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("## "))
    .map((line) => line.replace(/^..\s+/, "").replace(/^.* -> /, ""));
}

function hasChangelogChange(status: string): boolean {
  return changedFilesFromStatus(status).some((file) => file === "CHANGELOG.md" || file.endsWith("/CHANGELOG.md"));
}

function inferCategory(status: string): ChangelogCategory {
  const lines = status.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every((line) => /^D\s|^ D/.test(line))) return "Removed";
  if (lines.some((line) => /^A\s|^\?\?/.test(line))) return "Added";
  if (lines.some((line) => /^D\s|^ D/.test(line))) return "Removed";
  return "Changed";
}

function humanizePath(file: string): string {
  return file
    .replace(/^.*\//, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferDescription(status: string): string {
  const files = changedFilesFromStatus(status).filter((file) => file !== "CHANGELOG.md");
  if (files.length === 0) return "Updated project files.";
  if (files.length === 1) return `Updated ${files[0]}.`;

  const topLevel = new Set(files.map((file) => file.split("/")[0]));
  if (topLevel.size === 1) return `Updated ${[...topLevel][0]} files.`;

  const named = files.slice(0, 3).map(humanizePath).join(", ");
  return files.length > 3 ? `Updated ${named}, and related files.` : `Updated ${named}.`;
}

function commitSubject(category: ChangelogCategory, description: string): string {
  const verb = category === "Fixed" ? "Fix" : category === "Removed" ? "Remove" : category === "Added" ? "Add" : "Update";
  const clean = description.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  const withoutPrefix = clean.replace(/^(add|added|update|updated|change|changed|fix|fixed|remove|removed)\s+/i, "");
  const subject = `${verb} ${withoutPrefix}`.trim();
  return subject.length <= 72 ? subject : `${subject.slice(0, 69).trim()}...`;
}

function addChangelogEntry(root: string, category: ChangelogCategory, description: string): void {
  const changelogPath = join(root, "CHANGELOG.md");
  if (!existsSync(changelogPath)) return;

  const content = readFileSync(changelogPath, "utf-8");
  const lines = content.split("\n");
  const today = new Date().toLocaleDateString("en-CA");
  const categoryOrder: ChangelogCategory[] = ["Added", "Changed", "Fixed", "Removed"];
  const entryLines = description.split("\n").map((line, index) => index === 0 ? `- ${line}` : `  ${line}`);

  let dateIndex = lines.findIndex((line) => line.trim() === `## ${today}`);
  if (dateIndex === -1) {
    const titleIndex = lines.findIndex((line) => line.startsWith("# "));
    const insertIndex = titleIndex === -1 ? 0 : titleIndex + 1;
    lines.splice(insertIndex, 0, "", `## ${today}`, "");
    dateIndex = insertIndex + 1;
  }

  let categoryIndex = -1;
  for (let i = dateIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    if (lines[i] === `### ${category}`) {
      categoryIndex = i;
      break;
    }
  }

  if (categoryIndex === -1) {
    const desiredOrder = categoryOrder.indexOf(category);
    let insertIndex = dateIndex + 1;
    if (insertIndex < lines.length && lines[insertIndex].trim() === "") insertIndex++;

    while (insertIndex < lines.length && !lines[insertIndex].startsWith("## ")) {
      const match = lines[insertIndex].match(/^### (.+)$/);
      if (match) {
        const existingOrder = categoryOrder.indexOf(match[1] as ChangelogCategory);
        if (existingOrder !== -1 && existingOrder > desiredOrder) break;
      }
      insertIndex++;
    }

    const needsBlankBefore = insertIndex > dateIndex + 1 && lines[insertIndex - 1].trim() !== "";
    const needsBlankAfter = insertIndex < lines.length && lines[insertIndex].trim() !== "";
    lines.splice(insertIndex, 0, ...(needsBlankBefore ? [""] : []), `### ${category}`, "", ...entryLines, ...(needsBlankAfter ? [""] : []));
  } else {
    let insertIndex = categoryIndex + 1;
    if (insertIndex < lines.length && lines[insertIndex].trim() === "") insertIndex++;
    lines.splice(insertIndex, 0, ...entryLines);
  }

  writeFileSync(changelogPath, lines.join("\n"));
}

function colorGitLine(line: string, theme: any): string {
  if (line.startsWith("diff --git") || line.startsWith("index ")) return theme.fg("muted", line);
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return theme.fg("warning", line);
  if (line.startsWith("@@")) return theme.fg("accent", line);
  if (line.startsWith("+")) return theme.fg("success", line);
  if (line.startsWith("-")) return theme.fg("error", line);
  if (/^## /.test(line)) return theme.fg("accent", line);
  if (/^\?\? /.test(line) || /^A\s/.test(line)) return theme.fg("success", line);
  if (/^\s?M\s|^M\s/.test(line)) return theme.fg("warning", line);
  if (/^\s?D\s|^D\s/.test(line)) return theme.fg("error", line);
  return theme.fg("fg", line);
}

function sendGitOutput(pi: ExtensionAPI, title: string, kind: GitOutputDetails["kind"], content: string): void {
  pi.sendMessage({
    customType: "git-output",
    content,
    display: true,
    details: { title, kind } satisfies GitOutputDetails,
  });
}

async function handleStatus(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const root = await repoRoot(ctx.cwd);
  const status = await runGit(root, ["status", "--short", "--branch"]);
  sendGitOutput(pi, "git status", "status", status || "Working tree clean.");
}

async function handleDiff(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
  const root = await repoRoot(ctx.cwd);
  const parsedArgs = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  const diff = await runGit(root, ["diff", ...parsedArgs], 1024 * 1024 * 32);
  sendGitOutput(pi, `git diff${parsedArgs.length ? ` ${parsedArgs.join(" ")}` : ""}`, "diff", diff ? truncate(diff) : "No diff.");
}

async function handlePush(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
  const root = await repoRoot(ctx.cwd);
  const noChangelog = /(?:^|\s)--no-changelog(?:\s|$)/.test(args);
  const messageArg = args.replace(/(?:^|\s)--no-changelog(?:\s|$)/g, " ").trim();

  let status = await runGit(root, ["status", "--short"]);
  if (!status) {
    sendGitOutput(pi, "git push", "push", "No changes to commit.");
    return;
  }

  const category = inferCategory(status);
  const description = inferDescription(status);
  if (!noChangelog && existsSync(join(root, "CHANGELOG.md")) && !hasChangelogChange(status)) {
    addChangelogEntry(root, category, description);
    status = await runGit(root, ["status", "--short"]);
  }

  ctx.ui.setStatus("git", "Staging changes…");
  await runGit(root, ["add", "-A"]);

  const staged = await runGit(root, ["diff", "--cached", "--name-only"]);
  if (!staged) {
    ctx.ui.setStatus("git", "");
    sendGitOutput(pi, "git push", "push", "No staged changes after git add -A.");
    return;
  }

  const subject = messageArg || commitSubject(category, description);
  ctx.ui.setStatus("git", "Committing changes…");
  const commitOutput = await runGit(root, ["commit", "-m", subject]);

  ctx.ui.setStatus("git", "Pushing changes…");
  const pushOutput = await runGit(root, ["push", "origin", "HEAD"]);
  ctx.ui.setStatus("git", "");

  sendGitOutput(pi, "git push", "push", `Committed and pushed: ${subject}\n\n${truncate([commitOutput, pushOutput].filter(Boolean).join("\n"), 80)}`);
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("git-output", (message, { outputPad }, theme) => {
    const details = message.details as GitOutputDetails | undefined;
    const title = details?.title ?? "git";
    const headerColor = details?.kind === "error" ? "error" : details?.kind === "push" ? "success" : "accent";
    const lines = String(message.content ?? "").split("\n");
    const rendered = [theme.fg(headerColor, `▸ ${title}`), ...lines.map((line) => colorGitLine(line, theme))].join("\n");
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(rendered, 0, 0));
    return box;
  });

  pi.registerCommand("git", {
    description: "Git helpers: /git status, /git diff [args], /git push [message] [--no-changelog]",
    handler: async (args, ctx) => {
      const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        switch (subcommand) {
          case "status":
          case "st":
            await handleStatus(pi, ctx);
            return;
          case "diff":
            await handleDiff(pi, rest.join(" "), ctx);
            return;
          case "push":
            await handlePush(pi, rest.join(" "), ctx);
            return;
          default:
            sendGitOutput(pi, "git", "error", "Usage: /git status | /git diff [args] | /git push [message] [--no-changelog]");
        }
      } catch (error) {
        ctx.ui.setStatus("git", "");
        sendGitOutput(pi, `/git ${subcommand} failed`, "error", error instanceof Error ? error.message : String(error));
      }
    },
  });
}
