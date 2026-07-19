/**
 * Refreshes `src/models.json`, the bundled baseline for the gateway's model
 * catalog. At runtime the API refreshes itself daily via ModelCatalogService,
 * but the bundled file is what it serves until that first refresh succeeds —
 * so the daily `update-models` workflow keeps the baseline current too. The
 * collection logic lives in `src/model-catalog.ts` (provider APIs when keys
 * are configured, the public models.dev catalog otherwise); the file is only
 * rewritten when the catalog content actually changed, keeping workflow runs
 * diff-free on quiet days.
 *
 * Run it with `pnpm --filter @autonomo.us/api models:update`.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	buildModelCatalog,
	countCatalogModels,
	describeCatalogChanges,
	type ModelCatalog,
} from "../src/model-catalog.js";

export const MODELS_JSON_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"models.json",
);

export async function main(): Promise<void> {
	let previous: ModelCatalog | undefined;
	try {
		const parsed = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8"));
		if (parsed && typeof parsed === "object" && parsed.providers) {
			previous = parsed as ModelCatalog;
		}
	} catch {
		// Missing or unreadable file: build the catalog from scratch.
	}

	const { catalog, changed, changes } = await buildModelCatalog({ previous });
	const stats = `${Object.keys(catalog.providers).length} providers, ${countCatalogModels(catalog)} models`;

	if (!changed) {
		console.log(`Model catalog unchanged (${stats}).`);
		return;
	}

	writeFileSync(MODELS_JSON_PATH, `${JSON.stringify(catalog, null, "\t")}\n`);
	console.log(`Model catalog updated (${stats}).`);
	for (const line of describeCatalogChanges(changes)) {
		console.log(`  ${line}`);
	}

	// Surface the diff in the GitHub Actions run summary when available.
	if (process.env.GITHUB_STEP_SUMMARY && changes.length > 0) {
		const rows = changes.map(
			({ provider, added, removed }) =>
				`| ${provider} | ${added.join("<br>") || "—"} | ${removed.join("<br>") || "—"} |`,
		);
		appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`## Model catalog updated\n\n| Provider | Added | Removed |\n| --- | --- | --- |\n${rows.join("\n")}\n`,
		);
	}
}

// Only run as a CLI; importing this module (e.g. from tests) has no effect.
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
