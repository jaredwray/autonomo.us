import {
	API_TOKEN_PERMISSIONS,
	type ApiTokenPermission,
} from "@autonomo.us/common";
import {
	createApiToken,
	fetchApiTokens,
	revokeApiToken,
	rollApiToken,
	updateApiToken,
} from "./api.js";
import { TokensView, type TokenViewConfig } from "./TokensView.js";

const permissionGroups = [
	{
		resource: "loops",
		label: "Loops",
		choices: ["loops:report"],
		hint: "Allows an external system to report loop measurements.",
	},
	{
		resource: "models",
		label: "Models",
		choices: ["models:read", "models:edit"],
	},
	{
		resource: "routing",
		label: "Routing",
		choices: ["routing:read", "routing:edit"],
	},
	{ resource: "inference", label: "Inference", choices: ["inference:run"] },
	{ resource: "telemetry", label: "Telemetry", choices: ["telemetry:read"] },
	{
		resource: "synapse",
		label: "Synapse",
		choices: ["synapse:read", "synapse:edit"],
	},
	{
		resource: "channels",
		label: "Channels",
		choices: ["channels:read", "channels:edit"],
	},
	{
		resource: "proxies",
		label: "Proxies",
		choices: ["proxies:read", "proxies:edit"],
	},
	{ resource: "web", label: "Web", choices: ["web:fetch"] },
	{
		resource: "video",
		label: "Video",
		choices: ["video:read", "video:edit"],
	},
	{
		resource: "video-generate",
		label: "Video generation",
		choices: ["video:generate"],
	},
	{
		resource: "budgets",
		label: "Budgets",
		choices: ["budgets:read", "budgets:edit"],
	},
] as const;

const config: TokenViewConfig<ApiTokenPermission> = {
	title: "API Tokens",
	tokenLabel: "API",
	description: "Manage credentials for the applications using your gateway.",
	namePlaceholder: "Production gateway",
	emptyMessage: "No API tokens yet. Create a token to connect an application.",
	permissionHint:
		"Applies within this workspace, except Synapse, which the whole gateway shares for now. Edit includes Read. Uncheck all permissions for no access. Run allows chat and decisions. Synapse: Edit also covers import and export; proposals are decided by people only. Channels: Post includes Read and posts under the token's name; channels are created and managed in the dashboard. Proxies: Edit changes proxy keys and the ladder. Web: Fetch reads pages through the ladder, including paid proxies, within the workspace's limits. Video: Edit changes video provider keys and limits. Video: Generate starts videos on the workspace's providers, within its limits. Budgets: Edit changes what models may spend. Only owners and admins can manage API tokens.",
	permissions: API_TOKEN_PERMISSIONS,
	permissionGroups,
	api: {
		list: fetchApiTokens,
		create: createApiToken,
		update: updateApiToken,
		roll: rollApiToken,
		revoke: revokeApiToken,
	},
};
export function ApiTokensView({
	workspace,
}: {
	workspace?: { id: string; name: string };
}) {
	return <TokensView config={config} workspace={workspace} />;
}
