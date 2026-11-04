import {
	AGENT_TOKEN_PERMISSIONS,
	type AgentTokenPermission,
	DEFAULT_AGENT_TOKEN_PERMISSIONS,
} from "@autonomo.us/common";
import { TokenStore } from "./token-store.js";

/** Separate audience and collection: agent secrets cannot authenticate as API tokens. */
export class AgentTokenStore extends TokenStore<AgentTokenPermission> {
	constructor(mongodbUrl?: string, now = Date.now) {
		super(
			{
				collection: "gateway_agent_tokens",
				prefix: "agt",
				label: "Agent",
				permissions: AGENT_TOKEN_PERMISSIONS,
				defaultPermissions: DEFAULT_AGENT_TOKEN_PERMISSIONS,
			},
			mongodbUrl,
			now,
		);
	}
}
