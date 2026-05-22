#!/usr/bin/env -S node --experimental-strip-types
import fs from "node:fs";
import {
	type Api,
	getEnvApiKey,
	getModels,
	getProviders,
	type KnownProvider,
	type Model,
} from "@earendil-works/pi-ai";
import { resolveModel } from "./settings.ts";

const SETTINGS_PATH = `${process.env.HOME}/.pi/agent/settings.json`;

interface PiSettings {
	defaultProvider?: string;
	defaultModel?: string;
	packages?: string[];
}

function loadSettings(): PiSettings {
	try {
		return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
	} catch {
		return {};
	}
}

function saveSettings(settings: PiSettings): void {
	fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

// Discover extension providers by parsing extension source files
function loadExtensionProviders(): Map<string, Model<Api>[]> {
	const settings = loadSettings();
	const extensions = new Map<string, Model<Api>[]>();

	for (const pkg of settings.packages ?? []) {
		if (!pkg.startsWith("file:")) continue;
		const extPath = pkg
			.replace("file:~", process.env.HOME ?? "~")
			.replace("file:", "");
		try {
			const src = fs.readFileSync(extPath, "utf-8");
			// Match both registerProvider("name") and provider: "name" patterns
			const providerMatch =
				src.match(/registerProvider\s*\(\s*["']([a-zA-Z0-9_-]+)["']/) ??
				src.match(/provider\s*:\s*["']([a-zA-Z0-9_-]+)["']/);
			const baseUrlMatch = src.match(/baseUrl\s*:\s*["']([^"']+)["']/);
			const apiMatch = src.match(/api\s*:\s*["']([^"']+)["']/);
			const contextWindowMatch = src.match(/contextWindow\s*:\s*(\d+)/);
			const maxTokensMatch = src.match(/maxTokens\s*:\s*(\d+)/);
			const reasoningMatch = /reasoning\s*:\s*true/.test(src);
			const apiKeyMatch = src.match(/apiKey\s*:\s*["']([^"']+)["']/);
			const modelsMatch = src.match(/models\s*:\s*\[([\s\S]*?)\]/);

			if (!providerMatch?.[1] || !baseUrlMatch?.[1] || !apiMatch?.[1]) continue;

			const provider = providerMatch[1];
			const baseUrl = baseUrlMatch[1];
			const api = apiMatch[1] as Api;

			const models: Model<Api>[] = [];
			if (modelsMatch?.[1]) {
				// Extract model ids from objects like { id: "name", ... }
				const modelIds =
					modelsMatch[1]
						.match(/id\s*:\s*["']([^"']+)["']/g)
						?.map((m) => m.replace(/id\s*:\s*["']([^"']+)["']/, "$1")) ?? [];
				const ctxWindow = contextWindowMatch?.[1] ?? "0";
				const maxTok = maxTokensMatch?.[1] ?? "4096";
				const apiKey = apiKeyMatch?.[1];
				for (const id of modelIds) {
					models.push({
						id,
						name: id,
						api,
						provider,
						baseUrl,
						reasoning: reasoningMatch,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: parseInt(ctxWindow, 10),
						maxTokens: parseInt(maxTok, 10),
						headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
					});
				}
			}
			if (models.length > 0) {
				extensions.set(provider, models);
			}
		} catch {
			// skip unreadable extensions
		}
	}
	return extensions;
}

function hasApiKey(provider: string): boolean {
	try {
		return getEnvApiKey(provider as KnownProvider) !== undefined;
	} catch {
		// extension providers won't be in KnownProvider
		return false;
	}
}

function formatCtx(n: number): string {
	if (!n) return "";
	if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
	return `${n}`;
}

function showHelp(): void {
	process.stdout.write(
		"model — manage LLM provider and model selection\n" +
			"\n" +
			"Usage:\n" +
			"  model                       Show current model\n" +
			"  model list                  List available models\n" +
			"  model resolve               Output provider/model for piping\n" +
			"  model set <provider/model>  Set as default\n" +
			"  model help                  Show this help message\n" +
			"\n" +
			"Examples:\n" +
			"  model list                  # see available models\n" +
			"  model set anthropic/claude-sonnet-4-5\n" +
			"  model resolve               # outputs: anthropic/claude-sonnet-4-5\n",
	);
}

function showCurrent(): void {
	const { provider, modelName, model } = resolveModel();
	const cyan = "\x1b[36m";
	const reset = "\x1b[0m";
	const sep = `${cyan} · ${reset}`;

	let detail = "";
	if (model) {
		const parts: string[] = [];
		if (model.contextWindow)
			parts.push(`${formatCtx(model.contextWindow)} ctx`);
		if (model.reasoning) parts.push("reasoning");
		if (parts.length) detail = ` ${sep}${parts.join(` ${sep} `)}`;
	}

	process.stdout.write(`${cyan}${provider}/${modelName}${reset}${detail}\n`);
}

function listProviders(): void {
	const sdkProviders = getProviders();
	const extensions = loadExtensionProviders();
	const { provider: currentProvider, modelName: currentModel } = resolveModel();

	// Only show providers with keys set or from extensions
	const available = new Set<string>();
	for (const p of sdkProviders) {
		if (hasApiKey(p)) available.add(p);
	}
	for (const p of extensions.keys()) {
		available.add(p);
	}

	const cyan = "\x1b[36m";
	const dim = "\x1b[2m";
	const reset = "\x1b[0m";

	// Collect all models with their provider info
	type Entry = {
		spec: string;
		provider: string;
		model: Model<Api>;
		isExtension: boolean;
		isCurrent: boolean;
	};
	const entries: Entry[] = [];

	for (const p of available) {
		const extModels = extensions.get(p);
		const models = extModels ?? getModels(p as KnownProvider);
		const isExtension = extModels !== undefined;
		for (const m of models) {
			entries.push({
				spec: `${p}/${m.id}`,
				provider: p,
				model: m,
				isExtension,
				isCurrent: p === currentProvider && m.id === currentModel,
			});
		}
	}

	// Sort: current first, then by provider/model
	entries.sort((a, b) => {
		if (a.isCurrent) return -1;
		if (b.isCurrent) return 1;
		if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
		return a.model.id.localeCompare(b.model.id);
	});

	for (const e of entries) {
		const parts: string[] = [];
		if (e.model.contextWindow)
			parts.push(`${formatCtx(e.model.contextWindow)} ctx`);
		if (e.model.reasoning) parts.push("reasoning");
		const detail = parts.length ? `  ${parts.join(" · ")}` : "";
		const extLabel = e.isExtension ? ` ${dim}(extension)${reset}` : "";
		const currentMark = e.isCurrent ? ` ${cyan}← current${reset}` : "";

		const spec = e.isCurrent ? `${cyan}  ${e.spec}${reset}` : `  ${e.spec}`;

		process.stdout.write(`${spec}${detail}${extLabel}${currentMark}\n`);
	}
}

function resolve(): void {
	const { provider, modelName } = resolveModel();
	process.stdout.write(`${provider}/${modelName}\n`);
}

function setModel(spec: string): void {
	const slashIdx = spec.indexOf("/");
	if (slashIdx === -1) {
		process.stderr.write(`model set: expected provider/model, got '${spec}'\n`);
		process.exit(1);
	}

	const provider = spec.slice(0, slashIdx);
	const modelName = spec.slice(slashIdx + 1);

	// Validate provider exists
	const sdkProviders = getProviders();
	const extensions = loadExtensionProviders();
	const exists =
		sdkProviders.includes(provider as KnownProvider) ||
		extensions.has(provider);
	if (!exists) {
		process.stderr.write(`model set: unknown provider '${provider}'\n`);
		process.exit(1);
	}

	const settings = loadSettings();
	settings.defaultProvider = provider;
	settings.defaultModel = modelName;
	saveSettings(settings);
	process.stdout.write(`set default: ${spec}\n`);
}

async function main() {
	const [, , cmd, arg] = process.argv;

	if (cmd === "--help" || cmd === "-h" || cmd === "help") {
		showHelp();
		return;
	}

	switch (cmd) {
		case undefined:
		case "current":
			showCurrent();
			break;

		case "list":
			listProviders();
			break;

		case "resolve":
			resolve();
			break;

		case "set":
			if (!arg) {
				process.stderr.write("model set: expected provider/model\n");
				process.exit(1);
			}
			setModel(arg);
			break;

		default:
			process.stderr.write(`model: unknown command '${cmd}'\n`);
			process.stderr.write("Run 'model help' for usage.\n");
			process.exit(1);
	}
}

main().catch((err) => {
	process.stderr.write(`[model error] ${err}\n`);
	process.exit(1);
});
