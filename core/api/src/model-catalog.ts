import catalogJson from "./models.json" with { type: "json" };

export type CatalogModel = {
	/** Provider-native model id, e.g. `claude-sonnet-5` or `gpt-5.2`. */
	id: string;
	name: string;
	/** Release date (`YYYY-MM-DD`) when the source reports one. */
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
	/** Timestamp of the last run that actually changed the catalog. */
	updated: string;
	providers: Record<string, CatalogProvider>;
};

/**
 * Known models across providers, bundled from `models.json`. The file is
 * refreshed daily by the `update-models` workflow via
 * `scripts/update-models.ts`; edit that script, not the JSON, to change what
 * gets collected. Unlike the registry's routable list, this catalog is not
 * tied to the providers configured on this gateway.
 */
export const modelCatalog = catalogJson as ModelCatalog;
