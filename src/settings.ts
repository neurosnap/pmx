import fs from "node:fs";
import { getModel, type KnownProvider, type Model, type Api } from "@earendil-works/pi-ai";

interface PiSettings {
	defaultProvider?: string;
	defaultModel?: string;
	packages?: string[];
}

function loadPiSettings(): PiSettings {
	try {
		const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
		return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	} catch {
		return {};
	}
}

// Parse provider/model out of a pi extension file via regex — good enough for prototype
function loadExtensionModel(provider: string, modelId: string): Model<Api> | undefined {
	const piSettings = loadPiSettings();
	for (const pkg of piSettings.packages ?? []) {
		if (!pkg.startsWith("file:")) continue;
		const extPath = pkg.replace("file:~", process.env.HOME ?? "~").replace("file:", "");
		try {
			const src = fs.readFileSync(extPath, "utf-8");
			if (!src.includes(`"${provider}"`) && !src.includes(`'${provider}'`)) continue;

			const baseUrl = src.match(/baseUrl\s*:\s*["']([^"']+)["']/)?.[1];
			const api = src.match(/api\s*:\s*["']([^"']+)["']/)?.[1];
			const contextWindow = src.match(/contextWindow\s*:\s*(\d+)/)?.[1];
			const maxTokens = src.match(/maxTokens\s*:\s*(\d+)/)?.[1];
			const reasoning = /reasoning\s*:\s*true/.test(src);

			if (!baseUrl || !api) continue;

			const apiKey = src.match(/apiKey\s*:\s*["']([^"']+)["']/)?.[1];

			return {
				id: modelId,
				name: modelId,
				api: api as Api,
				provider,
				baseUrl,
				reasoning,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: parseInt(contextWindow ?? "0"),
				maxTokens: parseInt(maxTokens ?? "4096"),
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			};
		} catch {
			continue;
		}
	}
	return undefined;
}

export function resolveModel() {
	const piSettings = loadPiSettings();
	const provider = process.env.LLM_PROVIDER ?? piSettings.defaultProvider ?? "anthropic";
	const modelName = process.env.LLM_MODEL ?? piSettings.defaultModel ?? "claude-sonnet-4-5";
	// getModel returns undefined at runtime for unknown provider/model combos despite its types
	let model = getModel(provider as KnownProvider, modelName as never) as Model<Api> | undefined;
	if (!model) model = loadExtensionModel(provider, modelName);
	return { provider, modelName, model };
}
