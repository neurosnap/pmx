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
		cmd: "{command}"
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

async function main() {
	const [, , cmd] = process.argv;

	if (cmd === "path") {
		const p = getToolsPath();
		if (!fs.existsSync(p)) {
			saveTools(DEFAULT_TOOLS);
		}
		process.stdout.write(`${p}\n`);
		return;
	}

	if (cmd === "help") {
		const p = getToolsPath();
		process.stderr.write(
			"tool — manage tool definitions\n" +
				"\n" +
				"Usage:\n" +
				"  tool                          resolve tool calls from stdin (pipe mode)\n" +
				"  tool path                     print path to tools.json (" +
				p +
				")\n" +
				"  tool list                     list registered tools (name, description, cmd)\n" +
				"  tool help                     show this help\n" +
				"\n" +
				"Edit tools directly:\n" +
				"  vi $(tool path)\n",
		);
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
		if (!tool?.cmd) {
			process.stderr.write(`tool: no cmd for '${call.name}'\n`);
			continue;
		}
		const resolved = resolveCommand(tool.cmd, call.arguments);
		process.stdout.write(
			`${JSON.stringify({ id: call.id, name: call.name, cmd: resolved })}\n`,
		);
	}
}

main().catch((err) => {
	process.stderr.write(`[tool error] ${err}\n`);
	process.exit(2);
});
