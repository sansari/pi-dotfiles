/**
 * Todo Extension - File-backed todo list using TODO.md
 *
 * This extension:
 * - Reads and writes todos from/to `TODO.md` (falling back to `todo.md`) in the current working directory
 * - Preserves markdown structure (sections, headings, non-todo lines) on round-trips
 * - Understands the Pi Native-style priority sections: P0/P1/P2/P3
 * - Completes todos by removing them from the active list
 * - Registers a `todo` tool for the LLM to manage todos
 * - Registers a `/todos` command for users to open the list in the system Markdown app
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
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
	text: Type.Optional(Type.String({ description: "Todo text (for add). Plain text is formatted as `**(feat|bug) Text.**`; already-formatted markdown is preserved." })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
	priority: Type.Optional(StringEnum(["P0", "P1", "P2", "P3"] as const)),
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

type TodoPriority = "P0" | "P1" | "P2" | "P3";
type TodoKind = "feat" | "bug";

function formatTodoText(text: string, kind: TodoKind): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("**(")) return trimmed;
	const withPeriod = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
	return `**(${kind}) ${withPeriod}**`;
}

function sectionTitle(priority: TodoPriority): string {
	switch (priority) {
		case "P0": return "## P0: Critical";
		case "P1": return "## P1: Next";
		case "P2": return "## P2: Backlog";
		case "P3": return "## P3: Ideas";
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

		for (const line of lines) {
			const match = line.match(/^- \[([ x])\] (.+)$/);
			if (match) {
				const text = match[2];
				if (match[1] !== "x") {
					todos.push({ id, text });
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
			if (block.type === "text" && block.content.startsWith("## ")) break;
			insertIdx++;
		}

		// Insert at the end of the chosen section, before the next section header.
		// If the section ends with a blank spacer, insert before that spacer so
		// the Markdown remains visually tidy.
		if (insertIdx > headingIdx + 1) {
			const previous = fileBlocks[insertIdx - 1];
			if (previous?.type === "text" && previous.content.trim() === "") {
				insertIdx--;
			}
		}
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

		for (const block of fileBlocks) {
			if (block.type === "text") {
				lines.push(block.content);
			} else {
				const todo = todoMap.get(block.id);
				if (todo) {
					lines.push(`- [ ] ${todo.text}`);
					renderedIds.add(todo.id);
				}
				// Cleared/completed todos: omit their active block entirely
			}
		}

		// Append any new todos that aren't in fileBlocks yet to P1: Next.
		for (const todo of todos) {
			if (!renderedIds.has(todo.id)) {
				insertTodoIntoPrioritySection(todo.id, "P1");
				return saveToFile();
			}
		}

		await fs.writeFile(todosFilePath, lines.join("\n"), "utf-8");
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
		description: "Manage a todo list backed by TODO.md/todo.md. Actions: list, add (text, optional priority P0/P1/P2/P3, optional kind feat/bug), toggle/complete/delete (id), clear",
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
					const priority = (params.priority ?? "P1") as TodoPriority;
					const kind = (params.kind ?? (priority === "P0" ? "bug" : "feat")) as TodoKind;
					const newTodo: Todo = { id: nextId++, text: formatTodoText(params.text, kind) };
					todos.push(newTodo);
					insertTodoIntoPrioritySection(newTodo.id, priority);
					await saveToFile();
					return {
						content: [{ type: "text", text: `Added ${priority} ${kind} todo #${newTodo.id}: ${newTodo.text}` }],
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
					fileBlocks = fileBlocks.filter((block) => block.type !== "todo" || block.id !== todo.id);
					todos = todos.filter((t) => t.id !== todo.id);
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
		description: "Open TODO.md (or todo.md) in the system default Markdown app",
		handler: async (_args, ctx) => {
			const todoMarkdownPath = await findTodosPreviewFile(ctx.cwd);
			if (!todoMarkdownPath) {
				ctx.ui.notify("No TODO.md or todo.md found in this project.", "warning");
				return;
			}

			try {
				openFile(todoMarkdownPath);
				ctx.ui.notify(`Opened ${todoMarkdownPath}`, "info");
			} catch (error) {
				ctx.ui.notify(`/todos failed: ${(error as Error).message}`, "error");
			}
		},
	});
}
