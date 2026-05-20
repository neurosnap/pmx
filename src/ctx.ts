#!/usr/bin/env -S node --experimental-strip-types
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { resolveModel } from "./settings.ts";

function getMessagesPath(sessionOverride?: string): string {
	const session = sessionOverride ?? process.env.ZMX_SESSION;
	if (!session) {
		process.stderr.write("ctx: ZMX_SESSION not set\n");
		process.exit(1);
	}
	return path.join(process.env.HOME ?? "~", ".pmx", session, "messages.json");
}

function loadMessages(p: string): Message[] {
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8")) as Message[];
	} catch {
		return [];
	}
}

function saveMessages(p: string, messages: Message[]): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, `${JSON.stringify(messages, null, 2)}\n`);
}

function messageLabel(msg: Message): string {
	if (msg.role === "user") return "user";
	if (msg.role === "assistant") return "assistant";
	if (msg.role === "toolResult")
		return `result:${(msg as ToolResultMessage).toolName}`;
	return "unknown";
}

function messagePreview(msg: Message): string {
	if (msg.role === "user") {
		const m = msg as UserMessage;
		return typeof m.content === "string"
			? m.content
			: m.content.map((b) => ("text" in b ? b.text : "[image]")).join("");
	}
	if (msg.role === "assistant") {
		const m = msg as AssistantMessage;
		return m.content
			.map((b) => {
				if (b.type === "text") return b.text;
				if (b.type === "toolCall")
					return `[${b.name}] ${(b.arguments as { command?: string }).command ?? JSON.stringify(b.arguments)}`;
				if (b.type === "thinking") return `[thinking] ${b.thinking}`;
				return "";
			})
			.join("\n");
	}
	if (msg.role === "toolResult") {
		const m = msg as ToolResultMessage;
		return m.content.map((b) => ("text" in b ? b.text : "[image]")).join("");
	}
	return "";
}

// One-line format per message: "<index>\t<label>\t<preview>"
// Used for both view and edit — index is the deletion key.
function renderLine(index: number, msg: Message): string {
	const label = messageLabel(msg);
	const preview = messagePreview(msg).replace(/\n/g, "↵").slice(0, 120);
	return `${index}\t${label}\t${preview}`;
}

function viewMessages(messages: Message[]): void {
	for (const [i, msg] of messages.entries()) {
		process.stdout.write(`${renderLine(i + 1, msg)}\n`);
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8").trim();
}

// Subcommands where the only arg (if any) is an optional session name
const NO_ARG_SUBCOMMANDS = new Set([
	"path",
	"last-text",
	"view",
	"edit",
	"reset",
	"stats",
]);

async function main() {
	const [, , cmd, ...args] = process.argv;

	if (cmd === "list") {
		const pmxDir = path.join(process.env.HOME ?? "~", ".pmx");
		const sessions = fs.existsSync(pmxDir)
			? fs
					.readdirSync(pmxDir)
					.filter((d) => fs.existsSync(path.join(pmxDir, d, "messages.json")))
			: [];
		for (const s of sessions) process.stdout.write(`${s}\n`);
		return;
	}

	const sessionOverride = NO_ARG_SUBCOMMANDS.has(cmd ?? "")
		? args[0]
		: undefined;
	const messagesPath = getMessagesPath(sessionOverride);

	switch (cmd) {
		case "path": {
			process.stdout.write(`${messagesPath}\n`);
			break;
		}

		case "add": {
			const [type, ...rest] = args;
			const messages = loadMessages(messagesPath);

			if (type === "user") {
				const msg: UserMessage = {
					role: "user",
					content: rest.join(" "),
					timestamp: Date.now(),
				};
				messages.push(msg);
			} else if (type === "assistant") {
				const msg = JSON.parse(rest.join(" ")) as AssistantMessage;
				messages.push(msg);
			} else if (type === "tool-result") {
				const [id, name, ...outputParts] = rest;
				const msg: ToolResultMessage = {
					role: "toolResult",
					toolCallId: id ?? "",
					toolName: name ?? "",
					content: [{ type: "text", text: outputParts.join(" ") }],
					isError: false,
					timestamp: Date.now(),
				};
				messages.push(msg);
			} else {
				process.stderr.write(`ctx add: unknown type '${type}'\n`);
				process.exit(1);
			}

			saveMessages(messagesPath, messages);
			break;
		}

		case "add-assistant": {
			const raw = await readStdin();
			const msg = JSON.parse(raw) as AssistantMessage;
			const messages = loadMessages(messagesPath);
			messages.push(msg);
			saveMessages(messagesPath, messages);
			process.stdout.write(`${raw}\n`);
			break;
		}

		case "add-result": {
			const [id, name] = args;
			if (!id || !name) {
				process.stderr.write(
					"ctx add-result: usage: ctx add-result <id> <name>\n",
				);
				process.exit(1);
			}
			const text = await readStdin();
			const messages = loadMessages(messagesPath);
			const msg: ToolResultMessage = {
				role: "toolResult",
				toolCallId: id,
				toolName: name,
				content: [{ type: "text", text }],
				isError: false,
				timestamp: Date.now(),
			};
			messages.push(msg);
			saveMessages(messagesPath, messages);
			break;
		}

		case "stats": {
			const messages = loadMessages(messagesPath);
			const json = JSON.stringify(messages);
			const tokenEstimate = Math.round(json.length / 4);

			const { modelName, model } = resolveModel();
			const contextWindow = model?.contextWindow;

			const cyan = "\x1b[36m";
			const reset = "\x1b[0m";
			const sep = `${cyan} · ${reset}`;

			let tokenStr: string;
			if (contextWindow) {
				const pct = (tokenEstimate / contextWindow) * 100;
				const color =
					pct >= 80 ? "\x1b[31m" : pct >= 50 ? "\x1b[33m" : "\x1b[32m";
				const fmt = (n: number) =>
					n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`;
				tokenStr = `${color}${pct.toFixed(1)}%${reset} ${cyan}(${fmt(tokenEstimate)}/${fmt(contextWindow)})${reset}`;
			} else {
				tokenStr = `${cyan}~${(tokenEstimate / 1000).toFixed(0)}k tokens${reset}`;
			}

			process.stdout.write(
				`${cyan}${modelName}${reset}${sep}${tokenStr}${sep}${cyan}${messages.length} msgs${reset}\n`,
			);
			break;
		}

		case "last-text": {
			const messages = loadMessages(messagesPath);
			const last = [...messages]
				.reverse()
				.find((m) => m.role === "assistant") as AssistantMessage | undefined;
			if (last) {
				const text = last.content
					.filter((b) => b.type === "text")
					.map((b) => (b as { type: "text"; text: string }).text)
					.join("");
				process.stdout.write(text);
			}
			break;
		}

		case "view": {
			const messages = loadMessages(messagesPath);
			viewMessages(messages);
			break;
		}

		case "edit": {
			fs.mkdirSync(path.dirname(messagesPath), { recursive: true });
			const messages = loadMessages(messagesPath);
			if (messages.length === 0) {
				process.stderr.write("ctx edit: no messages\n");
				break;
			}

			const tmpfile = `/tmp/ctx-edit-${Date.now()}.txt`;
			const lines = `${messages.map((msg, i) => renderLine(i + 1, msg)).join("\n")}\n`;
			fs.writeFileSync(tmpfile, lines);

			const editor = process.env.EDITOR ?? "vi";
			execSync(`${editor} "${tmpfile}"`, { stdio: "inherit" });

			const edited = fs.readFileSync(tmpfile, "utf-8");
			fs.unlinkSync(tmpfile);

			const keptIndices = new Set(
				edited
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l.length > 0)
					.map((l) => parseInt(l.split("\t")[0] ?? "", 10))
					.filter((n) => !Number.isNaN(n) && n >= 1 && n <= messages.length),
			);

			const kept = messages.filter((_, i) => keptIndices.has(i + 1));
			saveMessages(messagesPath, kept);
			process.stderr.write(
				`ctx edit: kept ${kept.length} / ${messages.length} messages\n`,
			);
			break;
		}

		case "reset": {
			saveMessages(messagesPath, []);
			break;
		}

		default: {
			process.stderr.write(
				"usage: ctx <path|add user <text>|add assistant <json>|add tool-result <id> <name> <output>|add-assistant|add-results|view|stats|edit|reset>\n",
			);
			process.exit(1);
		}
	}
}

main().catch((err) => {
	process.stderr.write(`[ctx error] ${err}\n`);
	process.exit(1);
});
