#!/usr/bin/env -S node --experimental-strip-types
import fs from "node:fs";
import path from "node:path";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";

const TOOLS_PATH = path.join(process.env.HOME ?? "~", ".pmx", "tools.json");

const DEFAULT_TOOLS = [
	{
		name: "bash",
		description: "Run a shell command.",
		parameters: {
			type: "object" as const,
			properties: { command: { type: "string" } },
			required: ["command"],
		},
		cmd: "{command}",
	},
	{
		name: "write",
		description:
			"Write content to a file. Use this instead of heredocs or echo/printf for creating or overwriting files.",
		parameters: {
			type: "object" as const,
			properties: {
				file_path: {
					type: "string",
					description: "Absolute or relative path to the file",
				},
				content: {
					type: "string",
					description: "The full content to write to the file",
				},
			},
			required: ["file_path", "content"],
		},
	},
	{
		name: "edit",
		description:
			"Replace exact text in a file. The old_text must appear exactly once in the file. Prefer this over write for modifying existing files.",
		parameters: {
			type: "object" as const,
			properties: {
				file_path: {
					type: "string",
					description: "Absolute or relative path to the file",
				},
				old_text: {
					type: "string",
					description: "The exact text to find (must be unique in the file)",
				},
				new_text: {
					type: "string",
					description: "The replacement text",
				},
			},
			required: ["file_path", "old_text", "new_text"],
		},
	},
];

function getToolsPath(): string {
	return TOOLS_PATH;
}

function loadTools(): typeof DEFAULT_TOOLS {
	try {
		return JSON.parse(fs.readFileSync(getToolsPath(), "utf-8"));
	} catch {
		return DEFAULT_TOOLS;
	}
}

function saveTools(tools: typeof DEFAULT_TOOLS): void {
	const p = getToolsPath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, `${JSON.stringify(tools, null, 2)}\n`);
}

function resolveCommand(
	template: string,
	args: Record<string, unknown>,
): string {
	return template.replace(/\{(\w+)\}/g, (_match, key) => {
		const val = args[key];
		if (val === undefined) return `{${key}}`;
		if (typeof val === "string") return val;
		return JSON.stringify(val);
	});
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8").trim();
}

function showHelp(): void {
	const _p = getToolsPath();
	process.stdout.write(
		"tool — manage tool definitions and resolve LLM tool calls\n" +
			"\n" +
			"Usage:\n" +
			"  tool                          Resolve tool calls from stdin (pipe mode)\n" +
			"  tool path                     Print path to tools.json\n" +
			"  tool list                     List all registered tools\n" +
			"  tool help                     Show this help message\n" +
			"\n" +
			"Commands:\n" +
			"  path                          Print the path to the tools.json file.\n" +
			"                                Creates the file with defaults if it doesn't exist.\n" +
			"  list                          Print each tool as: name\tdescription\tcmd\n" +
			"  help                          Show this help message\n" +
			"  (no command)                  Pipe mode: read an assistant message JSON from stdin,\n" +
			"                                resolve tool calls against registered tools, and print\n" +
			"                                one JSON line per call to stdout.\n" +
			"\n" +
			"Editing tools:\n" +
			"  vi $(tool path)               Open tools.json in your editor to add/modify tools\n" +
			"\n" +
			"Examples:\n" +
			"  tool path                     # print ~/.pmx/tools.json\n" +
			"  tool list                     # show registered tools\n" +
			"  echo '{...}' | tool           # resolve tool calls from assistant message JSON\n" +
			"  llm $(ctx path) $(tool path) | ctx add-assistant | tool\n",
	);
}

async function main() {
	const [, , cmd] = process.argv;

	if (cmd === "--help" || cmd === "-h" || cmd === "help") {
		showHelp();
		return;
	}

	if (cmd === "path") {
		const p = getToolsPath();
		if (!fs.existsSync(p)) {
			saveTools(DEFAULT_TOOLS);
		}
		process.stdout.write(`${p}\n`);
		return;
	}

	if (cmd === "list") {
		const tools = loadTools();
		for (const t of tools) {
			const name = t.name;
			const desc = t.description;
			const command = t.cmd ?? "(no cmd)";
			process.stdout.write(`${name}\t${desc}\t${command}\n`);
		}
		return;
	}

	// No subcommand — pipe mode: resolve tool calls from stdin
	const tools = loadTools();
	const raw = await readStdin();

	if (!raw) {
		process.stderr.write("tool: empty stdin\n");
		process.exit(2);
	}

	const message = JSON.parse(raw) as AssistantMessage;
	const toolCalls = message.content.filter(
		(b): b is ToolCall => b.type === "toolCall",
	);

	if (toolCalls.length === 0) {
		process.exit(1);
	}

	for (const call of toolCalls) {
		const tool = tools.find((t) => t.name === call.name);
		if (!tool) {
			process.stderr.write(`tool: unknown tool '${call.name}'\n`);
			continue;
		}
		if (tool.cmd) {
			const resolved = resolveCommand(tool.cmd, call.arguments);
			process.stdout.write(
				`${JSON.stringify({ id: call.id, name: call.name, cmd: resolved })}\n`,
			);
		} else {
			process.stdout.write(
				`${JSON.stringify({ id: call.id, name: call.name, ...call.arguments })}\n`,
			);
		}
	}
}

main().catch((err) => {
	process.stderr.write(`[tool error] ${err}\n`);
	process.exit(2);
});
