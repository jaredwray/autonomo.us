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
	{ resource: "brain", label: "Brain", choices: ["brain:read", "brain:edit"] },
] as const;

const config: TokenViewConfig<ApiTokenPermission> = {
	title: "API Tokens",
	tokenLabel: "API",
	description: "Manage credentials for the applications using your gateway.",
	namePlaceholder: "Production gateway",
	emptyMessage: "No API tokens yet. Create a token to connect an application.",
	permissionHint:
		"Applies across this gateway. Edit includes Read. Uncheck all permissions for no access. Run allows chat and decisions. Brain: Edit also covers import and export; proposals are decided by people only. Only owners and admins can manage API tokens.",
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
export function ApiTokensView() {
	return <TokensView config={config} />;
}
