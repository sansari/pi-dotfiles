/**
 * Todo Extension - File-backed todo list using todo.md
 *
 * This extension:
 * - Reads and writes todos from/to `todo.md` in the current working directory
 * - Preserves markdown structure (sections, headings, non-todo lines) on round-trips
 * - Registers a `todo` tool for the LLM to manage todos
 * - Registers a `/todos` command for users to view the list
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
	done: boolean;
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
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
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

export default function (pi: ExtensionAPI) {
	// In-memory state loaded from todo.md
	let todos: Todo[] = [];
	let nextId = 1;
	let fileBlocks: FileBlock[] = []; // For round-trip preservation of markdown structure
	let todosFilePath: string | null = null;

	/**
	 * Parse todo.md into todos and fileBlocks (preserving all non-todo lines).
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
				const done = match[1] === "x";
				const text = match[2];
				todos.push({ id, text, done });
				fileBlocks.push({ type: "todo", id });
				id++;
			} else {
				fileBlocks.push({ type: "text", content: line });
			}
		}
		nextId = id;
	}

	/**
	 * Write current todos back to todo.md, preserving all non-todo lines.
	 * New todos (not in fileBlocks) are appended at the end.
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
					lines.push(`- [${todo.done ? "x" : " "}] ${todo.text}`);
					renderedIds.add(todo.id);
				}
				// Cleared todos: omit their block entirely
			}
		}

		// Append any new todos that aren't in fileBlocks yet
		for (const todo of todos) {
			if (!renderedIds.has(todo.id)) {
				fileBlocks.push({ type: "todo", id: todo.id });
				lines.push(`- [${todo.done ? "x" : " "}] ${todo.text}`);
			}
		}

		await fs.writeFile(todosFilePath, lines.join("\n"), "utf-8");
	}

	// Load from file on session start / tree navigation
	pi.on("session_start", async (_event, ctx) => {
		todosFilePath = path.join(ctx.cwd, "todo.md");
		await loadFromFile();
	});

	pi.on("session_tree", async (_event, ctx) => {
		todosFilePath = path.join(ctx.cwd, "todo.md");
		await loadFromFile();
	});

	// Register the todo tool for the LLM
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a todo list backed by todo.md. Actions: list, add (text), toggle (id), clear",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Ensure file path is set (in case session_start hasn't fired yet)
			if (!todosFilePath) {
				todosFilePath = path.join(ctx.cwd, "todo.md");
				await loadFromFile();
			}

			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
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
					const newTodo: Todo = { id: nextId++, text: params.text, done: false };
					todos.push(newTodo);
					await saveToFile();
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
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
					todo.done = !todo.done;
					await saveToFile();
					return {
						content: [{ type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }],
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
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
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
