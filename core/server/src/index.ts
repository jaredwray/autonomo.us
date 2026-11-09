export { AccountError, AccountStore } from "./auth/accounts.js";
export {
	type ApiConfig,
	configFromEnv,
	DEFAULT_ANTHROPIC_MODELS,
	type ProviderConfig,
} from "./config.js";
export {
	DEFAULT_FAILOVER_POLICY,
	FailoverPolicyStore,
	MAX_FAILOVER_TIMEOUT_MS,
} from "./failover.js";
export {
	type BuildOptions,
	type BuildResult,
	buildModelCatalog,
	type CatalogChange,
	type CatalogModel,
	type CatalogProvider,
	diffCatalogs,
	type ModelCatalog,
	modelCatalog,
	PROVIDERS,
	type ProviderSpec,
} from "./model-catalog.js";
export {
	MODEL_CATALOG_CACHE_KEY,
	ModelCatalogService,
	type ModelCatalogServiceOptions,
} from "./model-catalog-service.js";
export {
	type ModelProvider,
	ProviderRegistry,
	providerFromConfig,
	registryFromConfig,
	UnknownProviderError,
} from "./providers/registry.js";
export { toTokenUsage } from "./routes/chat.js";
export { ModelRouter, type RoutingPlan } from "./routing/router.js";
export {
	defaultRoutingConfig,
	RoutingError,
	RoutingSettingsStore,
} from "./routing/settings.js";
export {
	type CreateServerOptions,
	createServer,
	releaseRequestResources,
} from "./server.js";
export { SynapseError } from "./synapse/errors.js";
export {
	parseMarkdown,
	renderMarkdown,
	titleProblem,
} from "./synapse/markdown.js";
export { MemorySynapseRepository } from "./synapse/memory-repository.js";
export { MongoSynapseRepository } from "./synapse/mongo-repository.js";
export type { SynapseRepository } from "./synapse/repository.js";
export {
	MAX_BODY_LENGTH,
	MAX_NOTES_PER_SPACE,
	SynapseService,
	type SynapseServiceOptions,
} from "./synapse/synapse.js";
export { BUILTIN_TEMPLATES } from "./synapse/templates.js";
export {
	eventToDocument,
	MongoTelemetrySink,
	stripProviderPrefix,
	TELEMETRY_COLLECTION,
} from "./telemetry/mongo.js";
export {
	type ChatTelemetry,
	TelemetryService,
	type TelemetryServiceOptions,
} from "./telemetry/telemetry.js";
