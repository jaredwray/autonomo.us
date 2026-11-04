import {
	API_TOKEN_PERMISSIONS,
	type ApiTokenPermission,
	DEFAULT_API_TOKEN_PERMISSIONS,
} from "@autonomo.us/common";
import { TokenStore } from "./token-store.js";

export { ApiTokenError, secretMatches, tokenHash } from "./token-store.js";

export class ApiTokenStore extends TokenStore<ApiTokenPermission> {
	constructor(mongodbUrl?: string, now = Date.now) {
		super(
			{
				collection: "gateway_api_tokens",
				prefix: "aut",
				label: "API",
				permissions: API_TOKEN_PERMISSIONS,
				defaultPermissions: DEFAULT_API_TOKEN_PERMISSIONS,
			},
			mongodbUrl,
			now,
		);
	}
}
