import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ChangelogCategory = "Added" | "Changed" | "Fixed" | "Removed";

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

function truncate(text: string, maxLines = 80): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`].join("\n");
}

function firstSentence(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
}

function commitSubject(category: ChangelogCategory | undefined, description: string | undefined, fallback: string): string {
  const clean = firstSentence(description || fallback || "Update project");
  const verb = category === "Fixed" ? "Fix" : category === "Removed" ? "Remove" : category === "Added" ? "Add" : "Update";
  const withoutPrefix = clean.replace(/^(add|added|update|updated|change|changed|fix|fixed|remove|removed)\s+/i, "");
  const subject = `${verb} ${withoutPrefix}`.trim();
  return subject.length <= 72 ? subject : `${subject.slice(0, 69).trim()}...`;
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

function addChangelogEntry(root: string, category: ChangelogCategory, description: string): void {
  const changelogPath = join(root, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    throw new Error("CHANGELOG.md not found. Add one or run `/git push --no-changelog` if this repo intentionally has no changelog.");
  }

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
    lines.splice(
      insertIndex,
      0,
      ...(needsBlankBefore ? [""] : []),
      `### ${category}`,
      "",
      ...entryLines,
      ...(needsBlankAfter ? [""] : []),
    );
  } else {
    let insertIndex = categoryIndex + 1;
    if (insertIndex < lines.length && lines[insertIndex].trim() === "") insertIndex++;
    lines.splice(insertIndex, 0, ...entryLines);
  }

  writeFileSync(changelogPath, lines.join("\n"));
}

function latestChangelogBullet(root: string): { category?: ChangelogCategory; description?: string } {
  const changelogPath = join(root, "CHANGELOG.md");
  if (!existsSync(changelogPath)) return {};
  const lines = readFileSync(changelogPath, "utf-8").split("\n");
  let category: ChangelogCategory | undefined;
  for (const line of lines) {
    const categoryMatch = line.match(/^### (Added|Changed|Fixed|Removed)$/);
    if (categoryMatch) {
      category = categoryMatch[1] as ChangelogCategory;
      continue;
    }
    const bulletMatch = line.match(/^-\s+(.+)$/);
    if (bulletMatch) return { category, description: bulletMatch[1] };
  }
  return {};
}

async function promptForChangelog(ctx: ExtensionContext): Promise<{ category: ChangelogCategory; description: string } | null> {
  const category = await ctx.ui.select("Changelog category", ["Added", "Changed", "Fixed", "Removed"]);
  if (!category) return null;
  const description = await ctx.ui.input("Changelog entry", "Brief user-facing summary of these changes");
  if (!description || !description.trim()) return null;
  return { category: category as ChangelogCategory, description: description.trim() };
}

function codeBlock(language: string, text: string): string {
  return `\`\`\`${language}\n${text}\n\`\`\``;
}

async function handleStatus(ctx: ExtensionContext): Promise<void> {
  const root = await repoRoot(ctx.cwd);
  const status = await runGit(root, ["status", "--short", "--branch"]);
  ctx.ui.notify(status ? codeBlock("text", status) : "Working tree clean.", "info");
}

async function handleDiff(args: string, ctx: ExtensionContext): Promise<void> {
  const root = await repoRoot(ctx.cwd);
  const parsedArgs = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  const diffArgs = ["diff", ...parsedArgs];
  const diff = await runGit(root, diffArgs, 1024 * 1024 * 32);
  ctx.ui.notify(diff ? codeBlock("diff", truncate(diff, 240)) : "No diff.", "info");
}

async function handlePush(args: string, ctx: ExtensionContext): Promise<void> {
  const root = await repoRoot(ctx.cwd);
  const noChangelog = /(?:^|\s)--no-changelog(?:\s|$)/.test(args);
  const messageArg = args.replace(/(?:^|\s)--no-changelog(?:\s|$)/g, " ").trim();

  let status = await runGit(root, ["status", "--short"]);
  if (!status) {
    ctx.ui.notify("No changes to commit.", "info");
    return;
  }

  let changelogCategory: ChangelogCategory | undefined;
  let changelogDescription: string | undefined;
  if (!noChangelog && existsSync(join(root, "CHANGELOG.md")) && !hasChangelogChange(status)) {
    const entry = await promptForChangelog(ctx);
    if (!entry) {
      ctx.ui.notify("/git push cancelled: changelog entry is required unless CHANGELOG.md is already changed or --no-changelog is used.", "info");
      return;
    }
    addChangelogEntry(root, entry.category, entry.description);
    changelogCategory = entry.category;
    changelogDescription = entry.description;
    status = await runGit(root, ["status", "--short"]);
  } else if (!messageArg) {
    const latest = latestChangelogBullet(root);
    changelogCategory = latest.category;
    changelogDescription = latest.description;
  }

  const preview = truncate(await runGit(root, ["status", "--short", "--branch"]), 120);
  const ok = await ctx.ui.confirm("Commit and push?", `This will run git add -A, commit, and push origin HEAD.\n\n${preview}`);
  if (!ok) {
    ctx.ui.notify("/git push cancelled.", "info");
    return;
  }

  ctx.ui.setStatus("git", "Staging changes…");
  await runGit(root, ["add", "-A"]);

  const staged = await runGit(root, ["diff", "--cached", "--name-only"]);
  if (!staged) {
    ctx.ui.setStatus("git", "");
    ctx.ui.notify("No staged changes after git add -A.", "info");
    return;
  }

  const fallback = changedFilesFromStatus(status).slice(0, 3).join(", ") || "project";
  const subject = messageArg || commitSubject(changelogCategory, changelogDescription, fallback);

  ctx.ui.setStatus("git", "Committing changes…");
  const commitOutput = await runGit(root, ["commit", "-m", subject]);

  ctx.ui.setStatus("git", "Pushing changes…");
  const pushOutput = await runGit(root, ["push", "origin", "HEAD"]);
  ctx.ui.setStatus("git", "");

  ctx.ui.notify(`Committed and pushed: ${subject}\n\n${truncate([commitOutput, pushOutput].filter(Boolean).join("\n"), 80)}`, "info");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("git", {
    description: "Git helpers: /git status, /git diff [args], /git push [message] [--no-changelog]",
    handler: async (args, ctx) => {
      const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        switch (subcommand) {
          case "status":
          case "st":
            await handleStatus(ctx);
            return;
          case "diff":
            await handleDiff(rest.join(" "), ctx);
            return;
          case "push":
            await handlePush(rest.join(" "), ctx);
            return;
          default:
            ctx.ui.notify("Usage: /git status | /git diff [args] | /git push [message] [--no-changelog]", "error");
        }
      } catch (error) {
        ctx.ui.setStatus("git", "");
        ctx.ui.notify(`/git ${subcommand} failed:\n${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
