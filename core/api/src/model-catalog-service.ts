import { Cacheable } from "cacheable";
import {
	buildModelCatalog,
	countCatalogModels,
	describeCatalogChanges,
	type ModelCatalog,
	modelCatalog,
} from "./model-catalog.js";

export const MODEL_CATALOG_CACHE_KEY = "model-catalog";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type ModelCatalogServiceOptions = {
	/**
	 * Cacheable instance holding the refreshed catalog. Defaults to an
	 * in-memory cache with a one-day TTL; pass one with a `secondary` store
	 * (Redis, ...) to share the catalog across instances or restarts.
	 */
	cache?: Cacheable;
	/**
	 * Baseline catalog served until the first successful refresh. Defaults to
	 * the bundled `models.json`, which the update-models workflow keeps fresh.
	 */
	base?: ModelCatalog;
	/** How often `start()` re-checks the sources. Default: daily. */
	refreshIntervalMs?: number;
	/** Delay before retrying after a completely failed refresh. Default: 1h. */
	retryIntervalMs?: number;
	env?: Record<string, string | undefined>;
	fetchImpl?: typeof fetch;
	log?: (message: string) => void;
};

/**
 * Runtime model catalog for the gateway. `start()` queries the model sources
 * once at startup and then re-checks daily; results are kept in `cacheable`.
 * A refresh that cannot reach the sources keeps whatever catalog is already
 * held (falling back to the bundled `models.json` before the first success),
 * so `getCatalog()` always has something to serve and never fetches on the
 * request path.
 */
export class ModelCatalogService {
	private readonly cache: Cacheable;
	private readonly base: ModelCatalog;
	private readonly refreshIntervalMs: number;
	private readonly retryIntervalMs: number;
	private readonly env?: Record<string, string | undefined>;
	private readonly fetchImpl?: typeof fetch;
	private readonly log: (message: string) => void;

	/** Last successfully built catalog; survives cache expiry after failures. */
	private latest?: ModelCatalog;
	private inflight?: Promise<boolean>;
	private timer?: NodeJS.Timeout;
	private started = false;

	constructor(options: ModelCatalogServiceOptions = {}) {
		this.cache = options.cache ?? new Cacheable({ ttl: "1d" });
		this.base = options.base ?? modelCatalog;
		this.refreshIntervalMs = options.refreshIntervalMs ?? DAY_MS;
		this.retryIntervalMs = options.retryIntervalMs ?? HOUR_MS;
		this.env = options.env;
		this.fetchImpl = options.fetchImpl;
		this.log = options.log ?? ((message) => console.warn(message));
	}

	/**
	 * The current catalog: the cached refresh result when present, the last
	 * in-process refresh when the cache entry expired, the bundled baseline
	 * otherwise. Never triggers a fetch.
	 */
	async getCatalog(): Promise<ModelCatalog> {
		const cached = await this.cache.get<ModelCatalog>(MODEL_CATALOG_CACHE_KEY);
		return cached ?? this.latest ?? this.base;
	}

	/**
	 * Queries the model sources once and caches the result. Returns false —
	 * keeping the current catalog untouched — when the refresh could not be
	 * built at all; per-provider fetch failures are already absorbed by
	 * buildModelCatalog, which carries the previous entries forward.
	 */
	async refresh(): Promise<boolean> {
		this.inflight ??= this.doRefresh().finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	private async doRefresh(): Promise<boolean> {
		const previous = await this.getCatalog();
		try {
			const { catalog, changed, changes } = await buildModelCatalog({
				previous,
				env: this.env,
				fetchImpl: this.fetchImpl,
				log: this.log,
			});
			this.latest = catalog;
			await this.cache.set(MODEL_CATALOG_CACHE_KEY, catalog);
			if (changed) {
				this.log(
					`model catalog refreshed (${countCatalogModels(catalog)} models): ${
						describeCatalogChanges(changes).join("; ") || "metadata updated"
					}`,
				);
			}
			return true;
		} catch (error) {
			this.log(`model catalog refresh failed, keeping current (${error})`);
			return false;
		}
	}

	/**
	 * Runs the startup query and keeps re-checking: daily after a successful
	 * refresh, sooner (retryIntervalMs) after a failed one.
	 */
	start(): void {
		if (this.started) return;
		this.started = true;
		void this.runRefreshLoop();
	}

	stop(): void {
		this.started = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private async runRefreshLoop(): Promise<void> {
		const ok = await this.refresh();
		if (!this.started) return;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				void this.runRefreshLoop();
			},
			ok ? this.refreshIntervalMs : this.retryIntervalMs,
		);
		this.timer.unref?.();
	}
}
