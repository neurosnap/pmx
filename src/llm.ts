#!/usr/bin/env -S node --experimental-strip-types
import fs from "node:fs";
import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import { getEnvApiKey, stream } from "@earendil-works/pi-ai";
import { resolveModel } from "./settings.ts";

function loadOAuthCredentials(provider: string): string | undefined {
	try {
		const authPath = `${process.env.HOME}/.pi/agent/auth.json`;
		const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
		const creds = auth[provider];
		if (creds?.access && creds.expires > Date.now()) {
			return creds.access;
		}
	} catch {
		// no auth file or parse error — fall through
	}
	return undefined;
}

async function main() {
	const messagesPath = process.argv[2];
	const toolsPath = process.argv[3];
	if (!messagesPath || !toolsPath) {
		process.stderr.write("usage: llm <messages.json> <tools.json>\n");
		process.exit(1);
	}

	const messages: Message[] = JSON.parse(
		fs.readFileSync(messagesPath, "utf-8"),
	);
	const tools: Tool[] = JSON.parse(fs.readFileSync(toolsPath, "utf-8"));

	const { provider, model } = resolveModel();
	const date = new Date().toISOString().split("T")[0];
	const cwd = process.cwd();
	const availableTools = tools
		.map((t) => `- ${t.name}: ${t.description}`)
		.join("\n");
	const defaultSystemPrompt = `You are an expert coding assistant running inside a zmx terminal session. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${availableTools}

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- Prefer targeted commands over broad ones
- When editing files, read them first

Current date: ${date}
Current working directory: ${cwd}`;
	const systemPrompt = process.env.LLM_SYSTEM ?? defaultSystemPrompt;

	if (!model) {
		process.stderr.write(`[llm error] unknown provider/model: ${provider}\n`);
		process.exit(1);
	}

	// Resolve API key: extension headers > OAuth credentials > env vars
	const authHeader = model.headers?.Authorization;
	const apiKey =
		authHeader?.replace("Bearer ", "") ||
		loadOAuthCredentials(provider) ||
		getEnvApiKey(provider);

	const context: Context = {
		systemPrompt,
		tools,
		messages,
	};

	const st = stream(model, context, { apiKey });

	const dim = "\x1b[2m";
	const reset = "\x1b[0m";
	let inThinking = false;
	for await (const event of st) {
		if (event.type === "thinking_start") {
			process.stderr.write(dim);
			inThinking = true;
		} else if (event.type === "thinking_end") {
			if (inThinking) process.stderr.write(`${reset}\n`);
			inThinking = false;
		} else if (event.type === "thinking_delta") {
			// re-apply dim after each chunk so backticks don't break the style
			process.stderr.write(event.delta + dim);
		} else if (event.type === "text_delta") {
			if (inThinking) {
				process.stderr.write(`${reset}\n`);
				inThinking = false;
			}
			// qwen-chat-template emits a literal </think> token as a text delta
			const text = event.delta.replace(/<\/think>\n?/g, "");
			if (text) process.stderr.write(text);
		}
	}
	process.stderr.write("\n");

	const message = await st.result();

	// stdout: full assistant message JSON for ctx and the fish loop
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

main().catch((err) => {
	process.stderr.write(`[llm error] ${err}\n`);
	process.exit(1);
});
