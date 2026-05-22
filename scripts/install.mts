#!/usr/bin/env -S node --experimental-strip-types
import { execSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = resolve(process.env.HOME ?? "/", ".local", "bin");
await mkdir(dest, { recursive: true });

const tools: [string, string][] = [
	["src/ctx.ts", "ctx"],
	["src/llm.ts", "llm"],
	["src/model.ts", "model"],
	["src/tool.ts", "tool"],
	["pmx", "pmx"],
];

for (const [src, name] of tools) {
	const srcPath = resolve(projectRoot, src);
	const destPath = resolve(dest, name);

	execSync(`chmod +x "${srcPath}"`);
	execSync(`rm -f "${destPath}"`);
	execSync(`ln -sf "${srcPath}" "${destPath}"`);
	console.log(`  ${name}  →  ${destPath}`);
}

console.log(`\nDone! Tools installed to ${dest}`);
