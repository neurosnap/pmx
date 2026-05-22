#!/usr/bin/env -S node --experimental-strip-types
import { execSync } from "node:child_process";
import fs from "node:fs";
import type { AssistantMessage, Tool, ToolCall } from "@earendil-works/pi-ai";

const TOOLS: Tool[] = [
	{
		name: "bash",
		description: "Run a shell command.",
		parameters: {
			type: "object" as const,
			properties: { command: { type: "string" } },
			required: ["command"],
		},
	},
	{
		name: "write",
		description:
			"Create a new file or fully overwrite an existing file. Do NOT use this to modify existing files — use the edit tool instead.",
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
			"Replace exact text in an existing file. You MUST use this tool (not write) when modifying existing files. Each old_text must appear exactly once and must not overlap with other edits. Keep old_text as small as possible while still being unique. Merge nearby changes into one edit entry.",
		parameters: {
			type: "object" as const,
			properties: {
				file_path: {
					type: "string",
					description: "Absolute or relative path to the file",
				},
				edits: {
					type: "array",
					description:
						"One or more replacements. Each is matched against the original file, not incrementally.",
					items: {
						type: "object",
						properties: {
							old_text: {
								type: "string",
								description: "Exact text to find (must be unique in the file)",
							},
							new_text: {
								type: "string",
								description: "Replacement text",
							},
						},
						required: ["old_text", "new_text"],
					},
				},
			},
			required: ["file_path", "edits"],
		},
	},
];

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8").trim();
}

function showHelp(): void {
	process.stdout.write(
		"tool — resolve LLM tool calls and handle edit operations\n" +
			"\n" +
			"Usage:\n" +
			"  tool                          Resolve tool calls from stdin (pipe mode)\n" +
			"  tool list                     Print tool definitions as JSON\n" +
			"  tool edit <id> <file> <edits> Run an edit tool call\n" +
			"  tool help                     Show this help message\n" +
			"\n" +
			"Commands:\n" +
			"  (no command)                  Pipe mode: read an assistant message JSON from stdin,\n" +
			"                                and print one JSON line per tool call to stdout.\n" +
			"  list                          Print tool definitions as a JSON array to stdout.\n" +
			"  edit <id> <file> <edits>      Apply edits to a file and report the result.\n" +
			"                                <edits> is a JSON array of {old_text, new_text} objects.\n" +
			"\n" +
			"Examples:\n" +
			"  echo '{...}' | tool           # resolve tool calls from assistant message JSON\n" +
			"  tool list | llm $(ctx path) | ctx add-assistant | tool\n" +
			'  tool edit $id main.ts \'[{"old_text":"a","new_text":"b"}]\'\n',
	);
}

function reportResult(id: string, name: string, text: string): void {
	execSync(
		`printf '%s' '${text.replace(/'/g, "'\"'\"'")}' | ctx add-result '${id}' '${name}'`,
	);
}

function handleEdit(id: string, filePath: string, editsJson: string): void {
	const edits: { old_text: string; new_text: string }[] = JSON.parse(editsJson);

	if (!fs.existsSync(filePath)) {
		reportResult(id, "edit", `error: file not found: ${filePath}`);
		process.exit(1);
	}

	const fileContent = fs.readFileSync(filePath, "utf-8");

	// Validate each old_text appears exactly once
	for (const [i, edit] of edits.entries()) {
		const { old_text } = edit;
		let count = 0;
		let pos = fileContent.indexOf(old_text);
		while (pos !== -1) {
			count++;
			pos = fileContent.indexOf(old_text, pos + old_text.length);
		}
		if (count === 0) {
			const preview = old_text.replace(/\n/g, " ").slice(0, 60);
			reportResult(
				id,
				"edit",
				`error: edit[${i}] old_text not found in ${filePath}: "${preview}"`,
			);
			process.exit(1);
		} else if (count > 1) {
			const preview = old_text.replace(/\n/g, " ").slice(0, 60);
			reportResult(
				id,
				"edit",
				`error: edit[${i}] old_text appears ${count} times in ${filePath} (must be unique): "${preview}"`,
			);
			process.exit(1);
		}
	}

	// Apply edits in reverse order (by position) so offsets stay valid
	const indexedEdits = edits
		.map((edit) => ({
			...edit,
			pos: fileContent.indexOf(edit.old_text),
		}))
		.sort((a, b) => b.pos - a.pos);

	let result = fileContent;
	for (const { old_text, new_text } of indexedEdits) {
		const idx = result.indexOf(old_text);
		result =
			result.slice(0, idx) + new_text + result.slice(idx + old_text.length);
	}

	fs.writeFileSync(filePath, result);
	reportResult(
		id,
		"edit",
		`edited ${filePath} (${edits.length} edits applied)`,
	);
}

async function main() {
	const [, , cmd, ...args] = process.argv;

	if (cmd === "--help" || cmd === "-h" || cmd === "help") {
		showHelp();
		return;
	}

	if (cmd === "list") {
		process.stdout.write(`${JSON.stringify(TOOLS, null, 2)}\n`);
		return;
	}

	if (cmd === "edit") {
		const [id, filePath, editsJson] = args;
		if (!id || !filePath || !editsJson) {
			process.stderr.write(
				"tool edit: usage: tool edit <id> <file> <edits_json>\n",
			);
			process.exit(1);
		}
		handleEdit(id, filePath, editsJson);
		return;
	}

	// No subcommand — pipe mode: resolve tool calls from stdin
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
		const tool = TOOLS.find((t) => t.name === call.name);
		if (!tool) {
			process.stderr.write(`tool: unknown tool '${call.name}'\n`);
			continue;
		}
		process.stdout.write(
			`${JSON.stringify({ id: call.id, name: call.name, args: call.arguments })}\n`,
		);
	}
}

main().catch((err) => {
	process.stderr.write(`[tool error] ${err}\n`);
	process.exit(2);
});
