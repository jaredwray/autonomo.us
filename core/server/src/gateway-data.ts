import type { SetupInventory } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { MongoConnection, mongoOperationDeadlines } from "./mongo.js";
import {
	SYNAPSE_NOTES_COLLECTION,
	SYNAPSE_PROPOSALS_COLLECTION,
	SYNAPSE_SPACES_COLLECTION,
} from "./synapse/mongo-repository.js";
import { TELEMETRY_COLLECTION } from "./telemetry/mongo.js";

/**
 * Every collection the gateway writes except the setup marker
 * (`gateway_setup`), which setup rewrites itself. Clearing touches only these
 * names, because the database may hold other applications' data too.
 */
export const GATEWAY_COLLECTIONS = [
	"gateway_users",
	"gateway_invites",
	"gateway_api_tokens",
	"gateway_agent_tokens",
	"gateway_providers",
	"gateway_routing",
	"gateway_workspaces",
	"gateway_instance",
	SYNAPSE_NOTES_COLLECTION,
	SYNAPSE_SPACES_COLLECTION,
	SYNAPSE_PROPOSALS_COLLECTION,
	TELEMETRY_COLLECTION,
] as const;

/** Deleting a large telemetry collection outlasts the stores' 3 s deadline. */
const CLEAR_TIMEOUT_MS = 120_000;

/**
 * The gateway's saved data as a whole, for setup with a setup token: what is
 * already there, and deleting all of it to start fresh. Only with MongoDB; a
 * memory-only API starts fresh on every restart.
 */
export class GatewayData {
	private readonly mongo?: MongoConnection;
	constructor(mongodbUrl?: string) {
		this.mongo = mongodbUrl
			? new MongoConnection(
					mongodbUrl,
					(url) =>
						new MongoClient(url, {
							serverSelectionTimeoutMS: 1500,
							...mongoOperationDeadlines(CLEAR_TIMEOUT_MS),
							readPreference: "primary",
						}),
				)
			: undefined;
	}

	get canClear(): boolean {
		return Boolean(this.mongo);
	}

	/** Counts beyond team accounts and invites, which the account store reports. */
	async inventory(): Promise<Omit<SetupInventory, "accounts" | "invites">> {
		const mongo = this.mongo;
		if (!mongo)
			return {
				connections: 0,
				tokens: 0,
				workspaces: 0,
				notes: 0,
				usageEvents: 0,
			};
		const count = (name: string, filter = {}) =>
			mongo.collection(name).countDocuments(filter);
		const [
			connections,
			apiTokens,
			agentTokens,
			workspaces,
			notes,
			usageEvents,
		] = await Promise.all([
			count("gateway_providers"),
			count("gateway_api_tokens"),
			count("gateway_agent_tokens"),
			count("gateway_workspaces", { isDefault: { $ne: true } }),
			mongo.collection(SYNAPSE_NOTES_COLLECTION).estimatedDocumentCount(),
			mongo.collection(TELEMETRY_COLLECTION).estimatedDocumentCount(),
		]);
		return {
			connections,
			tokens: apiTokens + agentTokens,
			workspaces,
			notes,
			usageEvents,
		};
	}

	/**
	 * Deletes every document in the gateway's collections. Indexes stay, so
	 * stores that created theirs once keep the guarantees they rely on, such
	 * as unique emails. Safe to repeat after a partial failure.
	 */
	async clear(): Promise<void> {
		const mongo = this.mongo;
		if (!mongo) throw new Error("Clearing needs MongoDB.");
		for (const name of GATEWAY_COLLECTIONS)
			await mongo.collection(name).deleteMany({});
	}

	async close(): Promise<void> {
		await this.mongo?.close();
	}
}
