import catalogJson from "./models.json" with { type: "json" };

export type CatalogModel = {
	/** Provider-native model id, e.g. `claude-sonnet-5` or `gpt-5.2`. */
	id: string;
	name: string;
	/** Release date (`YYYY-MM-DD`, or `YYYY-MM`) when the source reports one. */
	released?: string;
};

export type CatalogProvider = {
	name: string;
	/**
	 * Where this provider's list came from: `api` when fetched from the
	 * provider's own models endpoint, `models.dev` for the public catalog.
	 */
	source: "api" | "models.dev";
	models: CatalogModel[];
};

export type ModelCatalog = {
	/** Timestamp of the last refresh that actually changed the catalog. */
	updated: string;
	providers: Record<string, CatalogProvider>;
};

/**
 * The baseline catalog bundled from `models.json`. It backs the gateway until
 * the first successful runtime refresh (see `ModelCatalogService`) and is
 * kept current by the daily `update-models` workflow via
 * `scripts/update-models.ts`, so a gateway that can never reach the model
 * sources still serves a reasonable catalog.
 */
export const modelCatalog = catalogJson as ModelCatalog;

export const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * Per-request budget: a stalled source must fail fast so the fallback path
 * (previous entry / models.dev) can run instead of hanging the refresh.
 */
export const FETCH_TIMEOUT_MS = 30_000;

type FetchLike = typeof fetch;

export type ProviderSpec = {
	/** Catalog key; also the provider id used by models.dev. */
	key: string;
	name: string;
	/** Environment variables checked, in order, for this provider's API key. */
	envKeys: string[];
	fetchModels(apiKey: string, fetchImpl: FetchLike): Promise<CatalogModel[]>;
};

/** Raw model row as collected from a source, before normalization. */
type RawModel = {
	id: unknown;
	name?: unknown;
	released?: unknown;
};

async function getJson(
	url: string | URL,
	headers: Record<string, string>,
	fetchImpl: FetchLike,
): Promise<unknown> {
	const response = await fetchImpl(url, {
		headers,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`GET ${url} failed with status ${response.status}`);
	}
	return response.json();
}

/**
 * Coerces the source's release marker into a `YYYY-MM-DD` (or month-only
 * `YYYY-MM`, which models.dev permits) date: providers report epoch seconds
 * (`created`), models.dev reports ISO dates.
 */
export function toReleaseDate(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return new Date(value * 1000).toISOString().slice(0, 10);
	}
	if (typeof value === "string") {
		const match = value.match(/^\d{4}-\d{2}(-\d{2})?/);
		if (match) return match[0];
	}
	return undefined;
}

/** Newest release first, undated models last, id as the tiebreak. */
export function compareCatalogModels(a: CatalogModel, b: CatalogModel): number {
	if (a.released !== b.released) {
		if (!a.released) return 1;
		if (!b.released) return -1;
		return a.released < b.released ? 1 : -1;
	}
	if (a.id < b.id) return -1;
	if (a.id > b.id) return 1;
	return 0;
}

/** Drops malformed rows, dedupes by id, and sorts deterministically. */
export function normalizeModels(rows: RawModel[]): CatalogModel[] {
	const byId = new Map<string, CatalogModel>();
	for (const row of rows) {
		const id = typeof row.id === "string" ? row.id.trim() : "";
		if (!id || byId.has(id)) continue;
		const name = typeof row.name === "string" ? row.name.trim() : "";
		const released = toReleaseDate(row.released);
		byId.set(id, {
			id,
			name: name || id,
			...(released ? { released } : {}),
		});
	}
	return [...byId.values()].sort(compareCatalogModels);
}

async function fetchAnthropicModels(
	apiKey: string,
	fetchImpl: FetchLike,
): Promise<CatalogModel[]> {
	const rows: RawModel[] = [];
	let afterId: string | undefined;
	// Hard page cap so a misbehaving `has_more` can never loop forever.
	for (let page = 0; page < 20; page++) {
		const url = new URL("https://api.anthropic.com/v1/models");
		url.searchParams.set("limit", "100");
		if (afterId) url.searchParams.set("after_id", afterId);
		const body = (await getJson(
			url,
			{ "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
			fetchImpl,
		)) as {
			data?: Array<{
				id?: unknown;
				display_name?: unknown;
				created_at?: unknown;
			}>;
			has_more?: unknown;
			last_id?: unknown;
		};
		for (const entry of body.data ?? []) {
			rows.push({
				id: entry.id,
				name: entry.display_name,
				released: entry.created_at,
			});
		}
		if (body.has_more !== true || typeof body.last_id !== "string") break;
		afterId = body.last_id;
	}
	return normalizeModels(rows);
}

async function fetchGoogleModels(
	apiKey: string,
	fetchImpl: FetchLike,
): Promise<CatalogModel[]> {
	const rows: RawModel[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < 20; page++) {
		const url = new URL(
			"https://generativelanguage.googleapis.com/v1beta/models",
		);
		url.searchParams.set("pageSize", "1000");
		if (pageToken) url.searchParams.set("pageToken", pageToken);
		const body = (await getJson(
			url,
			{ "x-goog-api-key": apiKey },
			fetchImpl,
		)) as {
			models?: Array<{ name?: unknown; displayName?: unknown }>;
			nextPageToken?: unknown;
		};
		for (const entry of body.models ?? []) {
			rows.push({
				// Gemini ids come namespaced as `models/gemini-...`.
				id:
					typeof entry.name === "string"
						? entry.name.replace(/^models\//, "")
						: entry.name,
				name: entry.displayName,
			});
		}
		if (typeof body.nextPageToken !== "string" || !body.nextPageToken) break;
		pageToken = body.nextPageToken;
	}
	return normalizeModels(rows);
}

/** Fetcher for any provider exposing an OpenAI-style GET /models endpoint. */
function openAiStyleModels(endpoint: string): ProviderSpec["fetchModels"] {
	return async (apiKey, fetchImpl) => {
		const body = (await getJson(
			endpoint,
			{ authorization: `Bearer ${apiKey}` },
			fetchImpl,
		)) as {
			data?: Array<{ id?: unknown; display_name?: unknown; created?: unknown }>;
		};
		return normalizeModels(
			(body.data ?? [])
				// These endpoints list what the caller's account can use, which
				// includes private fine-tunes (`ft:...` on OpenAI and Mistral).
				// Those are account-scoped, not catalog material — the workflow
				// would commit them to the repo. Routing them still works; the
				// registry is not limited to advertised models.
				.filter(
					(entry) =>
						!(typeof entry.id === "string" && entry.id.startsWith("ft:")),
				)
				.map((entry) => ({
					id: entry.id,
					name: entry.display_name,
					released: entry.created,
				})),
		);
	};
}

export const PROVIDERS: ProviderSpec[] = [
	{
		key: "anthropic",
		name: "Anthropic",
		envKeys: ["ANTHROPIC_API_KEY"],
		fetchModels: fetchAnthropicModels,
	},
	{
		key: "openai",
		name: "OpenAI",
		envKeys: ["OPENAI_API_KEY"],
		fetchModels: openAiStyleModels("https://api.openai.com/v1/models"),
	},
	{
		key: "google",
		name: "Google",
		envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
		fetchModels: fetchGoogleModels,
	},
	{
		key: "mistral",
		name: "Mistral",
		envKeys: ["MISTRAL_API_KEY"],
		fetchModels: openAiStyleModels("https://api.mistral.ai/v1/models"),
	},
	{
		key: "groq",
		name: "Groq",
		envKeys: ["GROQ_API_KEY"],
		fetchModels: openAiStyleModels("https://api.groq.com/openai/v1/models"),
	},
	{
		key: "xai",
		name: "xAI",
		envKeys: ["XAI_API_KEY"],
		fetchModels: openAiStyleModels("https://api.x.ai/v1/models"),
	},
	{
		key: "deepseek",
		name: "DeepSeek",
		envKeys: ["DEEPSEEK_API_KEY"],
		fetchModels: openAiStyleModels("https://api.deepseek.com/models"),
	},
];

type ModelsDevProvider = {
	name?: unknown;
	models?: Record<
		string,
		{ id?: unknown; name?: unknown; release_date?: unknown }
	>;
};

async function fetchModelsDev(
	fetchImpl: FetchLike,
): Promise<Record<string, ModelsDevProvider>> {
	const body = await getJson(MODELS_DEV_URL, {}, fetchImpl);
	if (!body || typeof body !== "object") {
		throw new Error("models.dev returned an unexpected payload");
	}
	return body as Record<string, ModelsDevProvider>;
}

function modelsDevEntry(
	spec: ProviderSpec,
	catalog: Record<string, ModelsDevProvider>,
): CatalogProvider | undefined {
	const provider = catalog[spec.key];
	if (!provider?.models) return undefined;
	const models = normalizeModels(
		Object.entries(provider.models).map(([id, model]) => ({
			id: model.id ?? id,
			name: model.name,
			released: model.release_date,
		})),
	);
	if (models.length === 0) return undefined;
	return { name: spec.name, source: "models.dev", models };
}

export type CatalogChange = {
	provider: string;
	added: string[];
	removed: string[];
};

export type BuildResult = {
	catalog: ModelCatalog;
	changed: boolean;
	changes: CatalogChange[];
};

export type BuildOptions = {
	previous?: ModelCatalog;
	env?: Record<string, string | undefined>;
	fetchImpl?: FetchLike;
	now?: () => Date;
	log?: (message: string) => void;
	providers?: ProviderSpec[];
};

/** Model-id level diff between two catalogs, for logs and commit summaries. */
export function diffCatalogs(
	previous: ModelCatalog | undefined,
	next: ModelCatalog,
): CatalogChange[] {
	const changes: CatalogChange[] = [];
	const keys = new Set([
		...Object.keys(next.providers),
		...Object.keys(previous?.providers ?? {}),
	]);
	for (const key of keys) {
		const before = new Set(
			(previous?.providers[key]?.models ?? []).map((model) => model.id),
		);
		const after = new Set(
			(next.providers[key]?.models ?? []).map((model) => model.id),
		);
		const added = [...after].filter((id) => !before.has(id)).sort();
		const removed = [...before].filter((id) => !after.has(id)).sort();
		if (added.length > 0 || removed.length > 0) {
			changes.push({ provider: key, added, removed });
		}
	}
	return changes.sort((a, b) => (a.provider < b.provider ? -1 : 1));
}

/** One line per changed provider, e.g. `anthropic: +claude-x -claude-y`. */
export function describeCatalogChanges(changes: CatalogChange[]): string[] {
	return changes.map(({ provider, added, removed }) => {
		const parts: string[] = [];
		if (added.length > 0) parts.push(`+${added.join(", +")}`);
		if (removed.length > 0) parts.push(`-${removed.join(", -")}`);
		return `${provider}: ${parts.join(" ")}`;
	});
}

export function countCatalogModels(catalog: ModelCatalog): number {
	return Object.values(catalog.providers).reduce(
		(total, provider) => total + provider.models.length,
		0,
	);
}

/**
 * Collects the model list for every provider and assembles the next catalog.
 *
 * Per provider: with an API key the provider's own endpoint wins; without one
 * the public models.dev catalog is used. When a source fails, the previous
 * catalog entry is kept (a flaky run must not shrink the catalog) — except
 * that a failed live fetch may still fall back to models.dev when the
 * previous entry did not come from the live API either.
 */
export async function buildModelCatalog(
	options: BuildOptions = {},
): Promise<BuildResult> {
	const {
		previous,
		env = process.env,
		fetchImpl = fetch,
		now = () => new Date(),
		log = (message) => console.warn(message),
		providers: specs = PROVIDERS,
	} = options;

	// models.dev covers every provider in one request; fetch it lazily and
	// at most once per run.
	let modelsDevPromise: Promise<Record<string, ModelsDevProvider>> | undefined;
	const modelsDev = () => {
		modelsDevPromise ??= fetchModelsDev(fetchImpl);
		return modelsDevPromise;
	};

	const providers: Record<string, CatalogProvider> = {};
	for (const spec of specs) {
		const previousEntry = previous?.providers[spec.key];
		const apiKey = spec.envKeys
			.map((envKey) => env[envKey]?.trim())
			.find((value) => value);

		let entry: CatalogProvider | undefined;
		if (apiKey) {
			try {
				const models = await spec.fetchModels(apiKey, fetchImpl);
				if (models.length === 0) {
					throw new Error("provider API returned no models");
				}
				entry = { name: spec.name, source: "api", models };
			} catch (error) {
				log(`${spec.key}: live fetch failed (${error}); falling back`);
				if (previousEntry?.source === "api") {
					entry = previousEntry;
				}
			}
		}
		if (!entry) {
			try {
				entry = modelsDevEntry(spec, await modelsDev());
				if (!entry) {
					log(`${spec.key}: not present in the models.dev catalog`);
				}
			} catch (error) {
				log(`${spec.key}: models.dev fetch failed (${error})`);
			}
		}
		entry ??= previousEntry;
		if (entry) {
			providers[spec.key] = entry;
		} else {
			log(`${spec.key}: no source available, provider skipped`);
		}
	}

	if (
		Object.keys(providers).length === 0 &&
		Object.keys(previous?.providers ?? {}).length > 0
	) {
		throw new Error(
			"every model source failed; refusing to replace the catalog with an empty one",
		);
	}

	const changed =
		JSON.stringify(previous?.providers ?? null) !== JSON.stringify(providers);
	const catalog: ModelCatalog = {
		updated:
			changed || !previous?.updated ? now().toISOString() : previous.updated,
		providers,
	};
	return { catalog, changed, changes: diffCatalogs(previous, catalog) };
}
