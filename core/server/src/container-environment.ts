/** Explicit runtime settings only; never forward deployment credentials wholesale. */
const SETTINGS = [
	"MONGODB_URI",
	"SETUP_TOKEN",
	"PUBLIC_URL",
	"DASHBOARD_URL",
	"CORS_ORIGIN",
	"SYNAPSE_TIME_ZONE",
	"WEB_FETCH_DISABLED",
	"FAILOVER_ENABLED",
	"FAILOVER_TARGETS",
	"FAILOVER_TIMEOUT_MS",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_MODELS",
	"OPENAI_COMPAT_API_KEY",
	"OPENAI_COMPAT_BASE_URL",
	"OPENAI_COMPAT_MODELS",
	"OPENAI_COMPAT_NAME",
	"GEMINI_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"GOOGLE_BASE_URL",
	"GEMINI_MODELS",
	"XAI_API_KEY",
	"XAI_BASE_URL",
	"XAI_MODELS",
	"ZENROWS_API_KEY",
	"ZENROWS_BASE_URL",
	"CLOUDFLARE_BROWSER_API_TOKEN",
	"CLOUDFLARE_BROWSER_BASE_URL",
	"BRIGHTDATA_API_KEY",
	"BRIGHTDATA_BASE_URL",
	"BRIGHTDATA_ZONE",
	"BRIGHTDATA_PRICE_PER_1000",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_BASE_URL",
	"CLOUDFLARE_MODELS",
	...[
		"OPENAI",
		"GROQ",
		"MISTRAL",
		"DEEPSEEK",
		"OPENROUTER",
		"TYPESAFE",
	].flatMap((prefix) =>
		["API_KEY", "BASE_URL", "MODELS"].map((suffix) => `${prefix}_${suffix}`),
	),
];
export function containerEnvironment(
	bindings: Record<string, unknown>,
): Record<string, string> {
	for (const name of ["MONGODB_URI", "PUBLIC_URL", "CONTAINER_CONTROL_TOKEN"]) {
		if (typeof bindings[name] !== "string" || !bindings[name])
			throw new Error(`Missing container setting: ${name}`);
	}
	if ((bindings.CONTAINER_CONTROL_TOKEN as string).length < 32)
		throw new Error("Container control token must have at least 32 characters");
	const origin = new URL(bindings.PUBLIC_URL as string);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw new Error("PUBLIC_URL must be an HTTPS origin");
	const env: Record<string, string> = {
		NODE_ENV: "production",
		HOST: "0.0.0.0",
		PORT: "3000",
		CONTAINER_MODE: "true",
		CONTAINER_CONTROL_TOKEN: bindings.CONTAINER_CONTROL_TOKEN as string,
	};
	for (const name of SETTINGS)
		if (typeof bindings[name] === "string") env[name] = bindings[name];
	// A runtime Workers AI key is deliberately distinct from a deploy token.
	if (typeof bindings.CLOUDFLARE_AI_API_TOKEN === "string")
		env.CLOUDFLARE_API_TOKEN = bindings.CLOUDFLARE_AI_API_TOKEN;
	return env;
}
