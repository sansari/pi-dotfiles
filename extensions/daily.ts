import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CommandResult = { stdout: string; stderr: string };
type DailyOptions = { since: string; copy: boolean; usesDefaultWindow: boolean };
type DailyUpdateEntry = { draft: string; copied: boolean; timestamp: number };

type TodoSections = {
	inProgress: string[];
	next: string[];
	critical: string[];
	done: string[];
};


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

const parseOptions = (args: string): DailyOptions => {
	const tokens = args.trim().match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
	let copy = true;
	const sinceParts: string[] = [];

	for (const token of tokens) {
		if (token === "--copy") copy = true;
		else if (token === "--no-copy") copy = false;
		else sinceParts.push(token);
	}

	return {
		since: sinceParts.length > 0 ? sinceParts.join(" ") : "24 hours ago",
		copy,
		usesDefaultWindow: sinceParts.length === 0,
	};
};

const stripMarkdownTask = (line: string): string => {
	return line
		.replace(/^[-*]\s+\[[ xX]\]\s+/, "")
		.replace(/^\d+\.\s+/, "")
		.replace(/^[-*]\s+/, "")
		.replace(/^\*\*\((feat|bug|chore)\)\s*/i, "**")
		.replace(/^\*\*((feat|bug|chore):\s*)/i, "$1")
		.replace(/\*\*$/g, "")
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
		if (/^(?:[-*]\s+\[[ xX]\]|\d+\.|[-*]\s+)/.test(line.trim())) {
			sections[current] = sections[current] ?? [];
			sections[current].push(stripMarkdownTask(line.trim()));
		}
	}
	return {
		inProgress: sections["In Progress"] ?? [],
		next: sections["Next"] ?? sections["P1: Next"] ?? [],
		critical: sections["Backlog"] ?? sections["P0: Critical"] ?? [],
		done: sections["Recently Done"] ?? sections["Done"] ?? [],
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

const commitSubjectsSince = async (root: string, since: string): Promise<string[]> => {
	const commits = await runGit(root, ["log", `--since=${since}`, "--pretty=format:%s"]).catch(() => "");
	return commits.split("\n").map((line) => line.trim()).filter(Boolean);
};

const latestCommitAnchoredSince = async (root: string): Promise<string | undefined> => {
	const latestUnix = await runGit(root, ["log", "-1", "--format=%ct"]).catch(() => "");
	const latestSeconds = Number.parseInt(latestUnix, 10);
	if (!Number.isFinite(latestSeconds)) return undefined;
	return new Date((latestSeconds - 24 * 60 * 60) * 1000).toISOString();
};

const summarizeCommits = async (root: string, options: DailyOptions): Promise<string[]> => {
	const anchoredSince = options.usesDefaultWindow ? await latestCommitAnchoredSince(root) : undefined;
	const since = anchoredSince ?? options.since;
	return commitSubjectsSince(root, since);
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
		.replace(/^\d{4}-\d{2}-\d{2}\s+/, "")
		.replace(/^\((feat|bug|chore)\)\s*/i, "")
		.trim();

const titleCase = (text: string): string =>
	text
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => {
			if (/^[A-Z0-9]{2,}$/.test(word)) return word;
			if (word.length <= 3 && word === word.toLowerCase()) return word;
			return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
		})
		.join(" ");

const applySimpleEnglish = (text: string): string =>
	text
		.replace(/\b[Ll]everag(?:e|ed|es|ing)\b/g, "Use")
		.replace(/\b[Uu]tiliz(?:e|ed|es|ing)\b/g, "Use")
		.replace(/\bin order to\b/gi, "to")
		.replace(/\bprior to\b/gi, "before")
		.replace(/\b[Ee]nsur(?:e|ed|es|ing)\b/g, "Make sure")
		.replace(/\b[Ss]hould\b/g, "must")
		.replace(/\b[Mm]ay\b/g, "can")
		.replace(/\b[Mm]ight\b/g, "can")
		.replace(/\b[Cc]ould\b/g, "can")
		.replace(/\b[Ww]ould\b/g, "will")
		.replace(/\b[Ss]eamlessly\b/g, "")
		.replace(/\b[Rr]obust\b/g, "")
		.replace(/\b[Cc]omprehensive\b/g, "")
		.replace(/\boepns\b/gi, "opens")
		.replace(/\bcombei?nd\b/gi, "combined")
		.replace(/\bbg\b/gi, "background")
		.replace(/\s+/g, " ")
		.trim();

const stripTodoPrefix = (text: string): string => text.replace(/^(feat|bug|chore)\s*:\s*/i, "").trim();

const cleanDailyItem = (item: string): string =>
	applySimpleEnglish(stripTodoPrefix(stripDecorativeMarkdown(item).replace(/\s+/g, " ").trim()))
		.replace(/\s+\([0-9a-f]{7,}\)$/i, "")
		.trim();

const truncateDetail = (detail: string, max = 190): string => {
	const clean = detail.trim().replace(/\s+/g, " ");
	return clean.length <= max ? clean : `${clean.slice(0, max - 1).replace(/\s+\S*$/, "").trim()}…`;
};

const projectSummary = (item: string): { title: string; detail?: string } | undefined => {
	const text = cleanDailyItem(item);
	const normalized = text.toLowerCase();

	if (normalized.includes("dmg release distribution plan") || normalized.includes("documented the dmg release distribution plan")) {
		return {
			title: "DMG release planning",
			detail: "documented the release path covering Apple Developer enrollment, Developer ID signing, notarization, manual GitHub release publication, polished DMG artwork, and checksums.",
		};
	}
	if (normalized.includes("internal unsigned dmg") || normalized.includes("unsigned dmg build")) {
		return {
			title: "Internal unsigned DMG build",
			detail: "added the packaging path for coworker testing, including shared scheme, build script, checksum output, warning text, and local docs.",
		};
	}
	if (normalized.includes("limit quick chats") || normalized.includes("quick chats to five") || normalized.includes("quick chats sidebar overflow")) {
		return { title: "Quick Chats overflow", detail: "limited collapsed Quick Chats to 5 rows before showing the ellipsis expander." };
	}
	if (normalized.includes("sidebar overflow ellipsis") || normalized.includes("project sidebar overflow ellipsis")) {
		return { title: "Sidebar overflow ellipsis", detail: "kept the overflow dots centered inside their hover pill with polished spacing." };
	}
	if (normalized.includes("left sidebar") && (normalized.includes("top gray") || normalized.includes("window chrome") || normalized.includes("menubar"))) {
		return { title: "Sidebar chrome match", detail: "matched the left sidebar background to the shared window chrome color." };
	}
	if (normalized.includes("review failing requirements checks")) {
		return { title: "Requirements checks", detail: "review failing requirement coverage and update the affected tests." };
	}
	if (normalized.includes("complete dmg distribution milestone")) {
		return { title: "DMG distribution milestone", detail: "complete signed/notarized release packaging, release workflow, docs, and maintainer checklist." };
	}
	if (normalized.includes("effort selector") || normalized.includes("effort picker")) {
		return { title: "Effort picker", detail: "split effort selection into its own compose control." };
	}
	if (normalized.includes("settings section") && normalized.includes("models")) {
		return { title: "Model favorites settings", detail: "add searchable model favorites, default from the current Pi model, and test OpenRouter/local model configs." };
	}
	if (normalized.includes("archived chats")) {
		return { title: "Archived Chats bug", detail: "open the correct pane and improve unarchive visibility in light and dark mode." };
	}
	if (normalized.includes("hiding left sidebar hides the compose box") || normalized.includes("left sidebar toggle")) {
		return { title: "Sidebar collapse bug", detail: "fix hiding the left sidebar also hiding the compose box." };
	}

	return undefined;
};

const splitBullet = (item: string): { title: string; detail?: string } => {
	const project = projectSummary(item);
	if (project) return project;

	const clean = cleanDailyItem(item);
	const explicit = clean.match(/^(.{3,72}?)(?:\s+[-–—:]\s+)(.+)$/);
	if (explicit) {
		return { title: titleCase(explicit[1].trim().replace(/[.,;:]$/, "")), detail: truncateDetail(explicit[2]) };
	}

	const sentence = clean.match(/^(.{8,72}?)\.\s+(.+)$/);
	if (sentence) {
		return { title: titleCase(sentence[1].trim().replace(/[.,;:]$/, "")), detail: truncateDetail(sentence[2]) };
	}

	const firstClause = clean.match(/^(.{3,72}?)(?:\s+(?:with|by|so that|including)\s+)(.+)$/i);
	if (firstClause) {
		return {
			title: titleCase(firstClause[1].trim().replace(/[.,;:]$/, "")),
			detail: truncateDetail(firstClause[2]),
		};
	}

	return { title: titleCase(truncateDetail(clean.replace(/[.,;:]$/, ""), 90)) };
};

const formatBullet = (item: string): string => {
	const { title, detail } = splitBullet(item);
	return detail ? `- **${title}** — ${detail}` : `- **${title}**`;
};

const formatBullets = (items: string[], fallback: string, limit = 6): string[] => {
	const selected = items.slice(0, limit);
	return (selected.length > 0 ? selected : [fallback]).map(formatBullet);
};

const similarEnough = (left: string, right: string): boolean => {
	const leftTokens = new Set(cleanDailyItem(left).toLowerCase().split(/\W+/).filter((token) => token.length > 3));
	const rightTokens = new Set(cleanDailyItem(right).toLowerCase().split(/\W+/).filter((token) => token.length > 3));
	if (leftTokens.size === 0 || rightTokens.size === 0) return false;
	let overlap = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) overlap++;
	return overlap >= 2 || overlap / Math.min(leftTokens.size, rightTokens.size) >= 0.45;
};

const normalizeDailyMarkdown = (draft: string): string => {
	let inBulletSection = false;
	return draft
		.split("\n")
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed) return "";
			if (/^\*(?:✅\s+)?(?:Recently Done|Done):\*$/.test(trimmed) || /^\*(?:🚧\s+)?In Progress:\*$/.test(trimmed) || /^\*(?:➡️\s+)?Next:\*$/.test(trimmed)) {
				inBulletSection = true;
				return trimmed;
			}
			if (trimmed === "**PiNative**" || trimmed === "**Pi Native**" || /^#{1,6}\s+/.test(trimmed)) {
				inBulletSection = false;
				return trimmed;
			}
			if (!inBulletSection) return trimmed;
			if (/^[-*]\s+/.test(trimmed)) return trimmed.replace(/^\*\s+/, "- ");
			return `- ${trimmed}`;
		})
		.join("\n");
};

const buildDaily = async (root: string, options: DailyOptions): Promise<string> => {
	const todoPath = join(root, "TODO.md");
	const hasTodo = existsSync(todoPath);
	const todo = hasTodo ? readFileSync(todoPath, "utf8") : "";
	const sections = parseTodoSections(todo);
	const commits = await summarizeCommits(root, options);
	const changelog = todayChangelogBullets(root);
	const todoDone = sections.done;
	const changelogOnly = changelog.filter((entry) => !todoDone.some((item) => similarEnough(item, entry)));
	const commitOnly = commits.filter((commit) => ![...todoDone, ...changelog].some((entry) => similarEnough(entry, commit)));
	const done = [...todoDone, ...changelogOnly, ...commitOnly].filter((item) => !isLowSignalChange(item));
	const inProgress = [...sections.inProgress];
	const next = sections.next.length > 0 ? sections.next : sections.critical;

	const lines = [
		"**PiNative**",
		"",
		"*✅ Done:*",
		...formatBullets(done, `No committed changes found in the last ${options.since}.`, 8),
	];

	if (hasTodo) {
		lines.push(
			"",
			"*🚧 In Progress:*",
			...formatBullets(inProgress, "No active TODOs found.", 6),
			"",
			"*➡️ Next:*",
			...formatBullets(next, "No next TODOs found.", 4),
		);
	}

	return normalizeDailyMarkdown(lines.join("\n"));
};

export default function dailyExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer<DailyUpdateEntry>("daily-update", (entry, _context, theme) => {
		const data = entry.data ?? { draft: "", copied: false, timestamp: Date.now() };
		const container = new Container();
		const header = `${theme.fg("accent", "Daily update")} ${theme.fg("dim", data.copied ? "copied to clipboard" : "not copied")}`;
		container.addChild(new Text(header, 0, 0));
		container.addChild(new Markdown(data.draft, 0, 1, getMarkdownTheme()));
		return container;
	});

	pi.registerCommand("daily", {
		description: "Draft a Slack-ready PiNative daily update from git, changelog, and TODO.md",
		getArgumentCompletions: (prefix) => {
			const options = ["--copy", "--no-copy", "24 hours ago", "today 00:00", "yesterday"];
			const matches = options.filter((option) => option.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const options = parseOptions(args);
			try {
				const root = await runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]);
				const draft = normalizeDailyMarkdown(await buildDaily(root, options));
				if (ctx.mode !== "tui") console.log(draft);
				if (options.copy) {
					await copyToClipboard(draft);
					ctx.ui.notify("Daily update copied to clipboard with Slack formatting", "info");
				}
				pi.appendEntry<DailyUpdateEntry>("daily-update", {
					draft,
					copied: options.copy,
					timestamp: Date.now(),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Daily update failed: ${message}`, "error");
				if (!ctx.hasUI) console.error(message);
			}
		},
	});
}
