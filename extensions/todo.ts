/**
 * Todo Extension - File-backed todo list using TODO.md
 *
 * This extension:
 * - Reads and writes todos from/to `TODO.md` (falling back to `todo.md`) in the current working directory
 * - Preserves markdown structure (sections, headings, non-todo lines) on round-trips
 * - Understands the Pi Native-style sections: In Progress, Next, Backlog, Recently Done
 * - Completes todos by moving them to a capped Recently Done history
 * - Registers a `todo` tool for the LLM to manage todos
 * - Registers a `/todos` command for users to format, add, start, status-check, finish, or open the list
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const doneSectionTitle = "## Recently Done";
const legacyDoneSectionTitle = "## Done";
const maxDoneItems = 20;

function isDoneSectionHeading(line: string): boolean {
	const trimmed = line.trim();
	return trimmed === doneSectionTitle || trimmed === legacyDoneSectionTitle;
}

interface Todo {
	id: number;
	text: string;
	priority: TodoPriority;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

// File block for round-trip preservation of markdown structure
type FileBlock =
	| { type: "text"; content: string }
	| { type: "todo"; id: number };

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add). Use `feat: ...` or `bug: ...` when applicable; unprefixed text is preserved." })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
	priority: Type.Optional(StringEnum(["in-progress", "next", "backlog", "P0", "P1", "P2", "P3"] as const)),
	kind: Type.Optional(StringEnum(["feat", "bug"] as const)),
});

function openFile(filePath: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	const child = spawn(command, [filePath], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
	child.unref();
}

async function findTodosPreviewFile(cwd: string): Promise<string | null> {
	for (const filename of ["TODO.md", "todo.md"]) {
		const candidate = path.join(cwd, filename);
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// Try the next conventional filename.
		}
	}
	return null;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 * 8 });
		return String(result.stdout ?? "").trim();
	} catch (error) {
		const err = error as Error & { stdout?: string; stderr?: string };
		throw new Error(`git ${args.join(" ")} failed: ${err.stderr || err.stdout || err.message}`);
	}
}

function truncateForCommit(text: string): string {
	const clean = normalizeTodoText(text)
		.replace(/[`*_#>\[\]()]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return clean.length <= 72 ? clean : `${clean.slice(0, 69).trim()}...`;
}

function changelogCategoryForTodo(text: string): "Added" | "Changed" | "Fixed" {
	const normalized = normalizeTodoText(text).toLowerCase();
	if (normalized.startsWith("bug:")) return "Fixed";
	if (normalized.startsWith("feat:")) return "Changed";
	return "Changed";
}

function changelogDescriptionForTodo(text: string): string {
	return `Completed TODO: ${normalizeTodoText(text).replace(/^(feat|bug):\s*/i, "")}`;
}

async function addChangelogEntryIfPresent(repoRoot: string, todoText: string): Promise<void> {
	const changelogPath = path.join(repoRoot, "CHANGELOG.md");
	let changelog: string;
	try {
		changelog = await fs.readFile(changelogPath, "utf-8");
	} catch {
		return;
	}

	const today = new Date().toLocaleDateString("en-CA");
	const category = changelogCategoryForTodo(todoText);
	const bullet = `- ${changelogDescriptionForTodo(todoText)}`;

	if (changelog.includes(bullet)) return;

	const todayHeading = `## ${today}`;
	const categoryHeading = `### ${category}`;
	if (!changelog.includes(todayHeading)) {
		const prefix = changelog.startsWith("# Changelog\n") ? "# Changelog\n\n" : "";
		const rest = prefix ? changelog.slice(prefix.length) : changelog;
		await fs.writeFile(changelogPath, `${prefix}${todayHeading}\n\n${categoryHeading}\n\n${bullet}\n\n${rest}`, "utf-8");
		return;
	}

	const todayStart = changelog.indexOf(todayHeading);
	const nextDayMatch = changelog.slice(todayStart + todayHeading.length).match(/\n## \d{4}-\d{2}-\d{2}/);
	const todayEnd = nextDayMatch ? todayStart + todayHeading.length + nextDayMatch.index! : changelog.length;
	const before = changelog.slice(0, todayStart);
	let todayBlock = changelog.slice(todayStart, todayEnd);
	const after = changelog.slice(todayEnd);

	if (!todayBlock.includes(categoryHeading)) {
		todayBlock = todayBlock.replace(/(## \d{4}-\d{2}-\d{2}\n+)/, `$1\n${categoryHeading}\n\n${bullet}\n`);
	} else {
		const categoryStart = todayBlock.indexOf(categoryHeading);
		const nextCategoryMatch = todayBlock.slice(categoryStart + categoryHeading.length).match(/\n### /);
		const insertAt = nextCategoryMatch ? categoryStart + categoryHeading.length + nextCategoryMatch.index! : todayBlock.length;
		const insertion = todayBlock[insertAt - 1] === "\n" ? `${bullet}\n` : `\n${bullet}\n`;
		todayBlock = `${todayBlock.slice(0, insertAt)}${insertion}${todayBlock.slice(insertAt)}`;
	}

	await fs.writeFile(changelogPath, `${before}${todayBlock}${after}`, "utf-8");
}

async function commitAndPushFinishedTodo(cwd: string, todoText: string): Promise<string> {
	const repoRoot = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	await addChangelogEntryIfPresent(repoRoot, todoText);
	await runGit(repoRoot, ["add", "-A"]);
	const status = await runGit(repoRoot, ["status", "--porcelain"]);
	if (!status) return "No git changes to commit.";
	const subject = `Finish TODO: ${truncateForCommit(todoText)}`;
	await runGit(repoRoot, ["commit", "-m", subject]);
	await runGit(repoRoot, ["push", "origin", "HEAD"]);
	return `Committed and pushed: ${subject}`;
}

type TodoPriority = "in-progress" | "next" | "backlog";
type TodoPriorityInput = TodoPriority | "P0" | "P1" | "P2" | "P3";
type TodoKind = "feat" | "bug";

function normalizeTodoText(text: string, kind?: TodoKind): string {
	let trimmed = text.trim();
	const boldMatch = trimmed.match(/^\*\*(.+)\*\*$/);
	if (boldMatch) trimmed = boldMatch[1].trim();

	const legacyKindMatch = trimmed.match(/^\((feat|bug)\)\s+(.+)$/i);
	if (legacyKindMatch) {
		return `${legacyKindMatch[1].toLowerCase()}: ${legacyKindMatch[2].trim()}`;
	}

	const prefixedMatch = trimmed.match(/^(feat|bug|chore)\s*:\s*(.+)$/i);
	if (prefixedMatch) {
		return `${prefixedMatch[1].toLowerCase()}: ${prefixedMatch[2].trim()}`;
	}

	if (kind) return `${kind}: ${trimmed}`;
	return trimmed;
}

function normalizeDoneText(text: string): string {
	const trimmed = text.trim();
	const dated = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
	if (dated) return `${dated[1]} ${normalizeTodoText(dated[2])}`;
	return normalizeTodoText(trimmed);
}

function normalizeDoneSection(content: string): string {
	const lines = content.split("\n");
	const headingIndex = lines.findIndex(isDoneSectionHeading);
	if (headingIndex === -1) return content;

	let endIndex = headingIndex + 1;
	while (endIndex < lines.length && !/^##\s+/.test(lines[endIndex].trim())) endIndex++;

	const doneItems = lines
		.slice(headingIndex + 1, endIndex)
		.map((line) => parseTodoLine(line.trim()))
		.filter((item): item is { text: string; checked: boolean } => Boolean(item))
		.map((item) => normalizeDoneText(item.text))
		.filter(Boolean)
		.slice(0, maxDoneItems);

	const rendered = [doneSectionTitle];
	if (doneItems.length > 0) {
		rendered.push("", ...doneItems.map((item, index) => `${index + 1}. ${item}`));
	}

	return [...lines.slice(0, headingIndex), ...rendered, ...lines.slice(endIndex)].join("\n");
}

async function addDoneItemToFile(filePath: string, todoText: string): Promise<void> {
	const today = new Date().toLocaleDateString("en-CA");
	const entry = `${today} ${normalizeTodoText(todoText)}`;
	let content = await fs.readFile(filePath, "utf-8").catch(() => "");
	const lines = content.split("\n");
	let headingIndex = lines.findIndex(isDoneSectionHeading);

	if (headingIndex === -1) {
		content = `${content.replace(/\s*$/g, "")}\n\n${doneSectionTitle}\n\n1. ${entry}\n`;
		await fs.writeFile(filePath, normalizeDoneSection(content), "utf-8");
		return;
	}

	let insertIndex = headingIndex + 1;
	while (insertIndex < lines.length && lines[insertIndex].trim() === "") insertIndex++;
	lines.splice(insertIndex, 0, `1. ${entry}`);
	await fs.writeFile(filePath, normalizeDoneSection(lines.join("\n")), "utf-8");
}

function parseTodoLine(line: string): { text: string; checked: boolean } | null {
	let match = line.match(/^\s*- \[([ xX])\]\s+(.+)$/);
	if (match) return { checked: match[1].toLowerCase() === "x", text: match[2] };

	match = line.match(/^\s*\d+\.\s+(.+)$/);
	if (match) return { checked: false, text: match[1] };

	match = line.match(/^\s*-\s+(.+)$/);
	if (match) return { checked: false, text: match[1] };

	return null;
}

function normalizePriority(priority: TodoPriorityInput | undefined): TodoPriority {
	switch (priority) {
		case "in-progress":
		case "next":
		case "backlog":
			return priority;
		case "P0":
			return "in-progress";
		case "P1":
			return "next";
		case "P2":
		case "P3":
		case undefined:
			return priority === undefined ? "next" : "backlog";
	}
}

function sectionTitle(priority: TodoPriority): string {
	switch (priority) {
		case "in-progress": return "## In Progress";
		case "next": return "## Next";
		case "backlog": return "## Backlog";
	}
}

export default function (pi: ExtensionAPI) {
	// In-memory state loaded from TODO.md / todo.md
	let todos: Todo[] = [];
	let nextId = 1;
	let fileBlocks: FileBlock[] = []; // For round-trip preservation of markdown structure
	let todosFilePath: string | null = null;

	async function ensureTodosFilePath(cwd: string): Promise<void> {
		const existing = await findTodosPreviewFile(cwd);
		todosFilePath = existing ?? path.join(cwd, "TODO.md");
	}

	/**
	 * Parse TODO.md/todo.md into active todos and fileBlocks, preserving all
	 * non-todo lines. Legacy checked todos are dropped on the next save.
	 */
	async function loadFromFile(): Promise<void> {
		if (!todosFilePath) return;

		todos = [];
		nextId = 1;
		fileBlocks = [];

		let content: string;
		try {
			content = await fs.readFile(todosFilePath, "utf-8");
		} catch {
			// File doesn't exist yet — start empty
			return;
		}

		// Split preserving trailing newline behavior
		const lines = content.split("\n");
		let id = 1;

		let currentPriority: TodoPriority | null = null;
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === sectionTitle("in-progress")) currentPriority = "in-progress";
			else if (trimmed === sectionTitle("next")) currentPriority = "next";
			else if (trimmed === sectionTitle("backlog")) currentPriority = "backlog";
			else if (trimmed.startsWith("## ")) currentPriority = null;

			const parsed = currentPriority ? parseTodoLine(line) : null;
			if (parsed) {
				if (!parsed.checked) {
					todos.push({ id, text: normalizeTodoText(parsed.text), priority: currentPriority });
					fileBlocks.push({ type: "todo", id });
					id++;
				}
				// Legacy checked todos are omitted: completed means deleted.
			} else {
				fileBlocks.push({ type: "text", content: line });
			}
		}
		nextId = id;
	}

	function insertTodoIntoPrioritySection(todoID: number, priority: TodoPriority): void {
		const desiredHeading = sectionTitle(priority);
		let headingIdx = fileBlocks.findIndex((block) => block.type === "text" && block.content.trim() === desiredHeading);

		if (headingIdx === -1) {
			// Keep the current repo convention: new sections are appended with a
			// blank line separator if they don't exist yet.
			if (fileBlocks.length > 0 && fileBlocks[fileBlocks.length - 1]?.type === "text" && fileBlocks[fileBlocks.length - 1].content.trim() !== "") {
				fileBlocks.push({ type: "text", content: "" });
			}
			fileBlocks.push({ type: "text", content: desiredHeading }, { type: "text", content: "" });
			headingIdx = fileBlocks.length - 2;
		}

		let insertIdx = headingIdx + 1;
		while (insertIdx < fileBlocks.length) {
			const block = fileBlocks[insertIdx];
			if (block.type === "text" && block.content.trim() === "") {
				insertIdx++;
				continue;
			}
			break;
		}

		// Insert at the top of the chosen section, after the heading and optional
		// spacer, so /todos next and /todos backlog behave like a current queue.
		fileBlocks.splice(insertIdx, 0, { type: "todo", id: todoID });
	}

	/**
	 * Write current active todos back to TODO.md/todo.md, preserving all
	 * non-todo lines. Completed/cleared todos are omitted.
	 */
	async function saveToFile(): Promise<void> {
		if (!todosFilePath) return;

		const todoMap = new Map(todos.map((t) => [t.id, t]));
		const renderedIds = new Set<number>();
		const lines: string[] = [];
		const sectionCounts: Record<TodoPriority, number> = { "in-progress": 0, next: 0, backlog: 0 };
		let currentPriority: TodoPriority | null = null;

		for (const block of fileBlocks) {
			if (block.type === "text") {
				const trimmed = block.content.trim();
				if (trimmed === sectionTitle("in-progress")) currentPriority = "in-progress";
				else if (trimmed === sectionTitle("next")) currentPriority = "next";
				else if (trimmed === sectionTitle("backlog")) currentPriority = "backlog";
				else if (trimmed.startsWith("## ")) currentPriority = null;
				lines.push(block.content);
			} else {
				const todo = todoMap.get(block.id);
				if (todo) {
					const priority = currentPriority ?? todo.priority;
					sectionCounts[priority]++;
					lines.push(`${sectionCounts[priority]}. ${normalizeTodoText(todo.text)}`);
					renderedIds.add(todo.id);
				}
				// Cleared/completed todos: omit their active block entirely
			}
		}

		// Append any new todos that aren't in fileBlocks yet to their selected section.
		for (const todo of todos) {
			if (!renderedIds.has(todo.id)) {
				insertTodoIntoPrioritySection(todo.id, todo.priority);
				return saveToFile();
			}
		}

		await fs.writeFile(todosFilePath, normalizeDoneSection(lines.join("\n")), "utf-8");
	}

	async function reloadAndSave(): Promise<void> {
		await loadFromFile();
		await saveToFile();
	}

	function todosInPriority(priority: TodoPriority): Todo[] {
		return todos.filter((todo) => todo.priority === priority);
	}

	function todoBySectionNumber(priority: TodoPriority, number: number): Todo | undefined {
		return todosInPriority(priority)[number - 1];
	}

	function removeTodo(todo: Todo): void {
		fileBlocks = fileBlocks.filter((block) => block.type !== "todo" || block.id !== todo.id);
		todos = todos.filter((t) => t.id !== todo.id);
	}

	function moveTodoToPriority(todo: Todo, priority: TodoPriority): void {
		removeTodo(todo);
		todo.priority = priority;
		todos.push(todo);
		insertTodoIntoPrioritySection(todo.id, priority);
	}

	// Load from file on session start / tree navigation
	pi.on("session_start", async (_event, ctx) => {
		await ensureTodosFilePath(ctx.cwd);
		await loadFromFile();
	});

	pi.on("session_tree", async (_event, ctx) => {
		await ensureTodosFilePath(ctx.cwd);
		await loadFromFile();
	});

	// Register the todo tool for the LLM
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list backed by TODO.md/todo.md. Actions: list, add (text, optional priority in-progress/next/backlog, optional kind feat/bug), toggle/complete/delete (id), clear. Todos are rendered as numbered list entries; text may use feat: or bug: prefixes.",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Ensure file path is set (in case session_start hasn't fired yet)
			if (!todosFilePath) {
				await ensureTodosFilePath(ctx.cwd);
				await loadFromFile();
			}

			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[ ] #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const priority = normalizePriority(params.priority as TodoPriorityInput | undefined);
					const newTodo: Todo = { id: nextId++, text: normalizeTodoText(params.text, params.kind as TodoKind | undefined), priority };
					todos.push(newTodo);
					insertTodoIntoPrioritySection(newTodo.id, priority);
					await saveToFile();
					return {
						content: [{ type: "text", text: `Added ${priority} todo #${newTodo.id}: ${newTodo.text}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "toggle",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					removeTodo(todo);
					await saveToFile();
					return {
						content: [{ type: "text", text: `Completed and removed todo #${todo.id}: ${todo.text}` }],
						details: { action: "toggle", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					// Remove todo blocks from fileBlocks so they're omitted on next save
					fileBlocks = fileBlocks.filter((b) => b.type === "text");
					await saveToFile();
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						listText += `\n${theme.fg("dim", "○")} ${theme.fg("accent", `#${t.id}`)} ${theme.fg("muted", t.text)}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}

				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	// Register the /todos command for users
	pi.registerCommand("todos", {
		description: "Manage TODO.md: /todos help, format, start N, status N, finish N, next TEXT, backlog TEXT, or bare /todos to open the file",
		handler: async (args, ctx) => {
			await ensureTodosFilePath(ctx.cwd);
			await loadFromFile();

			const [rawSubcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = rawSubcommand?.toLowerCase();

			try {
				switch (subcommand) {
					case undefined: {
						if (!todosFilePath) {
							ctx.ui.notify("No TODO.md or todo.md found in this project.", "warning");
							return;
						}
						openFile(todosFilePath);
						ctx.ui.notify(`Opened ${todosFilePath}`, "info");
						return;
					}

					case "help": {
						ctx.ui.notify([
							"/todos — open TODO.md",
							"/todos help — show this help",
							"/todos format — rewrite todos as numbered lists, normalize prefixes, and cap Done history",
							"/todos next TEXT — add TEXT to the top of Next",
							"/todos backlog TEXT — add TEXT to the top of Backlog",
							"/todos start N — move item N from Next to In Progress, then ask the agent to review and propose an implementation plan",
							"/todos status N — ask the agent for status on item N in In Progress; completed items should be removed",
							"/todos finish N — move item N from In Progress to Done, format TODO.md, update changelog when present, then commit and push",
						].join("\n"), "info");
						return;
					}

					case "format": {
						await reloadAndSave();
						ctx.ui.notify(`Formatted ${todosFilePath}`, "success");
						return;
					}

					case "start": {
						const number = Number(rest[0]);
						if (!Number.isInteger(number) || number < 1) {
							ctx.ui.notify("Usage: /todos start 3", "warning");
							return;
						}
						const todo = todoBySectionNumber("next", number);
						if (!todo) {
							ctx.ui.notify(`No Next todo #${number}`, "warning");
							return;
						}
						moveTodoToPriority(todo, "in-progress");
						await saveToFile();
						ctx.ui.notify(`Started: ${todo.text}`, "success");
						pi.sendUserMessage(`Review this newly started In Progress TODO and propose an implementation plan before making changes:\n\n${todo.text}\n\nInspect the relevant project files and current state. Give a concise plan with the likely files to change, verification steps, and any risks or questions. Prompt me to proceed before implementing.`);
						return;
					}

					case "status": {
						const number = Number(rest[0]);
						if (!Number.isInteger(number) || number < 1) {
							ctx.ui.notify("Usage: /todos status 3", "warning");
							return;
						}
						const todo = todoBySectionNumber("in-progress", number);
						if (!todo) {
							ctx.ui.notify(`No In Progress todo #${number}`, "warning");
							return;
						}
						pi.sendUserMessage(`Check the status of In Progress todo #${number}: ${todo.text}\n\nInspect the current project state yourself. If this todo is complete, remove it from In Progress by using the todo tool or editing TODO.md, then say it is done. If it is not complete, give a concise status summary and the next concrete steps. Do not implement the todo unless I explicitly ask you to; this is a status check only.`);
						return;
					}

					case "finish": {
						const number = Number(rest[0]);
						if (!Number.isInteger(number) || number < 1) {
							ctx.ui.notify("Usage: /todos finish 2", "warning");
							return;
						}
						const todo = todoBySectionNumber("in-progress", number);
						if (!todo) {
							ctx.ui.notify(`No In Progress todo #${number}`, "warning");
							return;
						}
						removeTodo(todo);
						await saveToFile();
						if (todosFilePath) await addDoneItemToFile(todosFilePath, todo.text);
						await reloadAndSave();
						const gitResult = await commitAndPushFinishedTodo(ctx.cwd, todo.text);
						ctx.ui.notify(`Finished: ${todo.text}\n${gitResult}`, "success");
						return;
					}

					case "next":
					case "backlog": {
						const text = args.trim().slice(subcommand.length).trim();
						if (!text) {
							ctx.ui.notify(`Usage: /todos ${subcommand} todo text`, "warning");
							return;
						}
						const priority = subcommand as TodoPriority;
						const newTodo: Todo = { id: nextId++, text: normalizeTodoText(text), priority };
						todos.push(newTodo);
						insertTodoIntoPrioritySection(newTodo.id, priority);
						await saveToFile();
						ctx.ui.notify(`Added to ${priority === "next" ? "Next" : "Backlog"}: ${newTodo.text}`, "success");
						return;
					}

					default:
						ctx.ui.notify("Usage: /todos help | format | start N | status N | finish N | next TEXT | backlog TEXT", "warning");
						return;
				}
			} catch (error) {
				ctx.ui.notify(`/todos failed: ${(error as Error).message}`, "error");
			}
		},
	});
}
