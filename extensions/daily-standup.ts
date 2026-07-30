import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CommandResult = { stdout: string; stderr: string };
type StandupOptions = { since: string; copy: boolean };

type TodoSections = {
	inProgress: string[];
	next: string[];
	critical: string[];
};

type TodoMatch = {
	line: string;
	text: string;
	score: number;
};

const preferencesPath = join(homedir(), ".pi", "agent", "standup-preferences.md");

const run = async (cwd: string, command: string, args: string[]): Promise<CommandResult> => {
	try {
		const result = await execFileAsync(command, args, { cwd, maxBuffer: 1024 * 1024 * 8 });
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	} catch (error) {
		const err = error as Error & { stdout?: string; stderr?: string };
		throw new Error(`${command} ${args.join(" ")} failed: ${err.stderr || err.stdout || err.message}`);
	}
};

const runGit = async (cwd: string, args: string[]): Promise<string> => (await run(cwd, "git", args)).stdout.trim();

const parseOptions = (args: string): StandupOptions => {
	const tokens = args.trim().match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
	let copy = true;
	const sinceParts: string[] = [];

	for (const token of tokens) {
		if (token === "--copy") copy = true;
		else if (token === "--no-copy") copy = false;
		else sinceParts.push(token);
	}

	return { since: sinceParts.length > 0 ? sinceParts.join(" ") : "24 hours ago", copy };
};

const stripMarkdownTask = (line: string): string => {
	return line
		.replace(/^[-*]\s+\[[ xX]\]\s+/, "")
		.replace(/^[-*]\s+/, "")
		.replace(/^\*\*\((feat|bug)\)\s*/i, "**")
		.replace(/\s+/g, " ")
		.trim();
};

const parseTodoSections = (todo: string): TodoSections => {
	const sections: Record<string, string[]> = {};
	let current = "";
	for (const line of todo.split("\n")) {
		const heading = line.match(/^##\s+(.+)$/);
		if (heading) {
			current = heading[1].trim();
			sections[current] = sections[current] ?? [];
			continue;
		}
		if (/^[-*]\s+\[[ xX]\]/.test(line.trim())) {
			sections[current] = sections[current] ?? [];
			sections[current].push(stripMarkdownTask(line.trim()));
		}
	}
	return {
		inProgress: sections["In Progress"] ?? [],
		next: sections["Next"] ?? sections["P1: Next"] ?? [],
		critical: sections["Backlog"] ?? sections["P0: Critical"] ?? [],
	};
};

const todayChangelogBullets = (root: string): string[] => {
	const path = join(root, "CHANGELOG.md");
	if (!existsSync(path)) return [];
	const changelog = readFileSync(path, "utf8");
	const today = new Date().toLocaleDateString("en-CA");
	const start = changelog.indexOf(`## ${today}`);
	if (start < 0) return [];
	const rest = changelog.slice(start).split("\n");
	const bullets: string[] = [];
	for (const line of rest.slice(1)) {
		if (/^##\s+\d{4}-\d{2}-\d{2}/.test(line)) break;
		const bullet = line.match(/^[-*]\s+(.+)/);
		if (bullet) bullets.push(bullet[1].trim());
	}
	return bullets;
};

const summarizeCommits = async (root: string, since: string): Promise<string[]> => {
	const commits = await runGit(root, ["log", `--since=${since}`, "--pretty=format:%s (%h)"]).catch(() => "");
	return commits.split("\n").map((line) => line.trim()).filter(Boolean);
};

const isLowSignalChange = (item: string): boolean => {
	const normalized = item.toLowerCase();
	const wordCount = normalized.split(/\s+/).filter(Boolean).length;
	const lowSignalPatterns = [
		/\bcopy\b/,
		/\bwording\b/,
		/\breword(?:ed|ing)?\b/,
		/\brename(?:d)?\b/,
		/\blabel\b/,
		/\bempty-state copy\b/,
		/\bchangelog\b/,
		/\btodo\b/,
		/\bguidance\b/,
	];
	return wordCount <= 14 && lowSignalPatterns.some((pattern) => pattern.test(normalized));
};

const copyToClipboard = async (text: string): Promise<void> => {
	const child = spawn("npx", ["--yes", "@slackfmt/cli@latest", "-f", "markdown"], {
		stdio: ["pipe", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});
	child.stdin?.end(text);
	await new Promise<void>((resolve, reject) => {
		child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `slackfmt exited with ${code}`)));
		child.on("error", reject);
	});
};

const stripDecorativeMarkdown = (text: string): string =>
	text
		.replace(/^[-*]\s+/, "")
		.replace(/\*\*/g, "")
		.replace(/^\((feat|bug)\)\s*/i, "")
		.trim();

const titleCase = (text: string): string =>
	text
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => word.length <= 3 && word === word.toLowerCase() ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
		.join(" ");

const splitBullet = (item: string): { title: string; detail?: string } => {
	const clean = stripDecorativeMarkdown(item).replace(/\s+/g, " ").trim();
	const explicit = clean.match(/^(.{3,70}?)(?:\s+[-–—:]\s+)(.+)$/);
	if (explicit) {
		return { title: titleCase(explicit[1].trim().replace(/[.,;:]$/, "")), detail: explicit[2].trim() };
	}

	const commitHash = clean.match(/\s+\([0-9a-f]{7,}\)$/i)?.[0] ?? "";
	const withoutHash = commitHash ? clean.slice(0, -commitHash.length).trim() : clean;

	const nowClause = withoutHash.match(/^(.{3,58}?)\s+now\s+(.+)$/i);
	if (nowClause) {
		return { title: titleCase(nowClause[1].trim()), detail: `now ${nowClause[2].trim()}${commitHash}` };
	}

	const sentence = withoutHash.match(/^(.{8,62}?)\.\s+(.+)$/);
	if (sentence) {
		return { title: titleCase(sentence[1].trim().replace(/[.,;:]$/, "")), detail: `${sentence[2].trim()}${commitHash}` };
	}

	const firstClause = withoutHash.match(/^(.{3,56}?)(?:\s+(?:with|by|so that|so|including)\s+)(.+)$/i);
	if (firstClause) {
		return {
			title: titleCase(firstClause[1].trim().replace(/[.,;:]$/, "")),
			detail: `${firstClause[2].trim()}${commitHash}`,
		};
	}

	const words = withoutHash.split(/\s+/).filter(Boolean);
	if (words.length <= 6) {
		return { title: titleCase(withoutHash.replace(/[.,;:]$/, "")), detail: commitHash.trim() || undefined };
	}

	const title = words.slice(0, 5).join(" ").replace(/[.,;:]$/, "");
	const detail = `${words.slice(5).join(" ")}${commitHash ? ` ${commitHash.trim()}` : ""}`.trim();
	return { title: titleCase(title), detail };
};

const formatBullet = (item: string): string => {
	const { title, detail } = splitBullet(item);
	return detail ? `- **${title}** — ${detail}` : `- **${title}**`;
};

const formatBullets = (items: string[], fallback: string, limit = 6): string[] => {
	const selected = items.slice(0, limit);
	return (selected.length > 0 ? selected : [fallback]).map(formatBullet);
};

const normalizeStandupMarkdown = (draft: string): string => {
	let inBulletSection = false;
	return draft
		.split("\n")
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed) return "";
			if (trimmed === "*Done:*" || trimmed === "*In Progress:*" || trimmed === "*Next:*") {
				inBulletSection = true;
				return trimmed;
			}
			if (trimmed === "**Pi Native**" || /^#{1,6}\s+/.test(trimmed)) {
				inBulletSection = false;
				return trimmed;
			}
			if (!inBulletSection) return trimmed;
			if (/^[-*]\s+/.test(trimmed)) return trimmed.replace(/^\*\s+/, "- ");
			return `- ${trimmed}`;
		})
		.join("\n");
};

const wordsForMatch = (text: string): Set<string> => {
	const stop = new Set(["a", "an", "and", "are", "as", "be", "for", "from", "i", "is", "it", "of", "on", "or", "the", "this", "to", "was", "were", "with", "done", "complete", "completed", "finish", "finished", "task"]);
	return new Set(stripDecorativeMarkdown(text).toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 2 && !stop.has(word)) ?? []);
};

const findCompletedTodoFromFeedback = (todoContent: string, feedback: string): TodoMatch | undefined => {
	if (!/\b(done|complete|completed|finished|remove|clear)\b/i.test(feedback)) return undefined;
	const feedbackWords = wordsForMatch(feedback);
	if (feedbackWords.size === 0) return undefined;

	const matches: TodoMatch[] = [];
	for (const line of todoContent.split("\n")) {
		if (!/^[-*]\s+\[[ xX]\]\s+/.test(line.trim())) continue;
		const text = stripMarkdownTask(line.trim());
		const todoWords = wordsForMatch(text);
		let score = 0;
		for (const word of feedbackWords) {
			if (todoWords.has(word)) score += 1;
		}
		if (score > 0) matches.push({ line, text, score });
	}
	return matches.sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0];
};

const maybeApplyTodoCompletionFeedback = async (root: string, feedback: string, ctx: ExtensionCommandContext): Promise<boolean> => {
	const todoPath = join(root, "TODO.md");
	if (!existsSync(todoPath) || !ctx.hasUI) return false;
	const current = readFileSync(todoPath, "utf8");
	const match = findCompletedTodoFromFeedback(current, feedback);
	if (!match || match.score < 2) return false;

	const ok = await ctx.ui.confirm("Update TODO.md?", `Remove this completed todo from TODO.md?\n\n${match.text}`);
	if (!ok) return false;

	const updated = current
		.split("\n")
		.filter((line) => line !== match.line)
		.join("\n");
	writeFileSync(todoPath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
	ctx.ui.notify("Removed completed todo from TODO.md", "info");
	return true;
};

const readStandupPreferences = (): string => {
	if (!existsSync(preferencesPath)) return "";
	return readFileSync(preferencesPath, "utf8").trim();
};

const rememberStandupPreference = (feedback: string): void => {
	mkdirSync(dirname(preferencesPath), { recursive: true });
	const date = new Date().toLocaleDateString("en-CA");
	appendFileSync(preferencesPath, `\n- ${date}: ${feedback.trim()}\n`, "utf8");
};

const buildStandup = async (root: string, options: StandupOptions): Promise<string> => {
	const todoPath = join(root, "TODO.md");
	const todo = existsSync(todoPath) ? readFileSync(todoPath, "utf8") : "";
	const sections = parseTodoSections(todo);
	const commits = await summarizeCommits(root, options.since);
	const changelog = todayChangelogBullets(root);
	const done = [...changelog, ...commits.filter((commit) => !changelog.some((entry) => commit.toLowerCase().includes(entry.slice(0, 30).toLowerCase())))]
		.filter((item) => !isLowSignalChange(item));
	const inProgress = [...sections.inProgress];
	const next = sections.next.length > 0 ? sections.next : sections.critical;

	return normalizeStandupMarkdown([
		"**Pi Native**",
		"",
		"*Done:*",
		...formatBullets(done, `No committed/changelog changes found in the last ${options.since}.`, 8),
		"",
		"*In Progress:*",
		...formatBullets(inProgress, "No active in-progress TODOs found.", 6),
		"",
		"*Next:*",
		...formatBullets(next, "No next TODOs found.", 5),
	].join("\n"));
};

const showStandupPreview = async (summary: string, ctx: ExtensionCommandContext): Promise<void> => {
	if (ctx.mode !== "tui") {
		console.log(summary);
		return;
	}

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));

		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold("Daily Standup Draft (Markdown)")), 1, 0));
		container.addChild(new Text(summary, 1, 1));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to continue"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
			},
		};
	});
};

const reviseStandup = async (
	draft: string,
	feedback: string,
	ctx: ExtensionCommandContext,
	standingPreferences = "",
): Promise<string> => {
	const model = ctx.model as Model<any> | undefined;
	if (!model) {
		return normalizeStandupMarkdown(`${draft}\n\n_Requested change:_ ${feedback}`);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		return normalizeStandupMarkdown(`${draft}\n\n_Requested change:_ ${feedback}`);
	}

	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user" as const,
					content: [{
						type: "text" as const,
						text: [
							"Revise this Slack standup draft according to the user's requested change.",
							"Keep the same Markdown three-section format: **Pi Native**, blank line, *Done:*, blank line, *In Progress:*, blank line, *Next:*.",
							"Every bullet must use this readable Slack-friendly Markdown shape: - **Short phrase** — details when useful.",
							standingPreferences ? `Standing preferences to apply on every standup:\n${standingPreferences}` : "No standing preferences are saved yet.",
							"Return only the revised standup text.",
							"",
							"<draft>",
							draft,
							"</draft>",
							"",
							"<requested_change>",
							feedback,
							"</requested_change>",
						].join("\n"),
					}],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			reasoningEffort: "low",
			cacheRetention: "none",
			sessionId: uuidv7(),
		},
	);

	const revised = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
	return normalizeStandupMarkdown(revised || draft);
};

const reviewLoop = async (summary: string, root: string, options: StandupOptions, ctx: ExtensionCommandContext): Promise<string | undefined> => {
	let draft = normalizeStandupMarkdown(summary);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		draft = normalizeStandupMarkdown(draft);
		await showStandupPreview(draft, ctx);
		if (!ctx.hasUI) return draft;

		const ok = await ctx.ui.confirm("Standup ready?", "Is this OK to copy/share?");
		if (ok) return draft;

		const feedback = await ctx.ui.input("What should change?", "e.g. Follow up on Promote is done; make Done higher-level; always omit copy tweaks");
		if (!feedback?.trim()) return undefined;

		const todoChanged = await maybeApplyTodoCompletionFeedback(root, feedback.trim(), ctx);
		if (todoChanged) {
			draft = normalizeStandupMarkdown(await buildStandup(root, options));
		}

		const remember = await ctx.ui.confirm("Remember for future standups?", "Should this become standing guidance for future /standup runs?");
		if (remember) {
			rememberStandupPreference(feedback.trim());
			ctx.ui.notify("Saved standup preference", "info");
		}

		ctx.ui.notify("Revising standup draft...", "info");
		draft = normalizeStandupMarkdown(await reviseStandup(draft, feedback.trim(), ctx, readStandupPreferences()));
	}
	return draft;
};

export default function dailyStandupExtension(pi: ExtensionAPI) {
	pi.registerCommand("standup", {
		description: "Draft a Slack-ready Pi Native standup from git, changelog, and TODO.md",
		getArgumentCompletions: (prefix) => {
			const options = ["--copy", "--no-copy", "24 hours ago", "today 00:00", "yesterday"];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const options = parseOptions(args);
			try {
				const root = await runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]);
				const initial = await buildStandup(root, options);
				const finalDraft = await reviewLoop(initial, root, options, ctx);
				if (!finalDraft) {
					ctx.ui.notify("Standup cancelled", "info");
					return;
				}
				if (options.copy) {
					await copyToClipboard(normalizeStandupMarkdown(finalDraft));
					ctx.ui.notify("Standup copied to clipboard with Slack formatting", "info");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Standup failed: ${message}`, "error");
				if (!ctx.hasUI) console.error(message);
			}
		},
	});
}
