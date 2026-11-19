import type {
	DecisionEvidence,
	OrgActorRef,
	OrgIdentity,
} from "@autonomo.us/common";
import type { AccountStore } from "../auth/accounts.js";
import type { AgentTokenStore } from "../auth/agent-tokens.js";
import type { BotRepository } from "../bots/repository.js";
import type { ChannelService } from "../channels/channels.js";
import type { OAuthService } from "../oauth/oauth.js";
import type { WorkspaceStore } from "../workspaces/store.js";

export type OrgPrincipal = {
	identity: OrgIdentity;
	use: boolean;
	decide: boolean;
	manage: boolean;
};
export type OrganizationDirectory = {
	active(workspaceId: string): Promise<boolean>;
	resolve(
		workspaceId: string,
		actor: OrgActorRef,
	): Promise<OrgPrincipal | null>;
	list(workspaceId: string): Promise<OrgIdentity[]>;
	evidence(
		workspaceId: string,
		actor: OrgActorRef,
		ref: DecisionEvidence,
	): Promise<boolean>;
};

export function organizationDirectory(
	workspaces: WorkspaceStore,
	accounts: AccountStore,
	tokens: AgentTokenStore,
	bots: BotRepository,
	channels: ChannelService,
	oauth: OAuthService,
): OrganizationDirectory {
	return {
		active: async (w) => {
			const workspace = await workspaces.get(w);
			return !!workspace && !workspace.archivedAt;
		},
		async resolve(w, actor) {
			if (actor.kind === "user") {
				const m = await accounts.workspaceMember(w, actor.id);
				return m
					? {
							identity: {
								kind: "user",
								id: m.id,
								name: m.name || m.email,
								type: "human",
							},
							use: true,
							decide: true,
							manage: m.role === "admin",
						}
					: null;
			}
			const bot = await bots.getBot(w, actor.id);
			if (bot)
				return bot.enabled
					? {
							identity: {
								kind: "agent",
								id: bot.id,
								name: bot.name,
								type: "instructions",
							},
							use: bot.tools,
							decide: bot.tools && bot.organizationDecisions === true,
							manage: false,
						}
					: null;
			const agent = await tokens.find(actor.id);
			if (
				!agent ||
				agent.status !== "active" ||
				(agent.workspaceId ?? (await workspaces.defaultWorkspaceId())) !== w
			)
				return null;
			const connected =
				agent.auth !== "oauth" ||
				(await oauth.connections(w, agent.id)).length > 0;
			return {
				identity: {
					kind: "agent",
					id: agent.id,
					name: agent.name,
					type: agent.auth,
				},
				use: connected && agent.permissions.includes("mcp:call"),
				decide:
					connected &&
					agent.permissions.includes("organization:decide") &&
					agent.permissions.includes("mcp:call"),
				manage: false,
			};
		},
		async list(w) {
			const workspace = await workspaces.get(w);
			if (!workspace) return [];
			const [people, external, hosted] = await Promise.all([
				accounts.workspaceMembers(workspace),
				tokens.settings(workspace, true),
				bots.listBots(w),
			]);
			return [
				...people.members.map((m) => ({
					kind: "user" as const,
					id: m.id,
					name: m.name || m.email,
					type: "human" as const,
				})),
				...external.tokens
					.filter((a) => a.status === "active")
					.map((a) => ({
						kind: "agent" as const,
						id: a.id,
						name: a.name,
						type: a.auth,
					})),
				...hosted
					.filter((b) => b.enabled)
					.map((b) => ({
						kind: "agent" as const,
						id: b.id,
						name: b.name,
						type: "instructions" as const,
					})),
			].sort(
				(a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
			);
		},
		async evidence(w, actor, { ref }) {
			// work: is an opaque source-system identifier. It carries neither content nor a capability.
			if (/^work:[A-Za-z0-9][A-Za-z0-9._:/-]{0,249}$/.test(ref)) return true;
			const parts = /^channel:([\w-]{1,100}):([\w-]{1,100})$/.exec(ref);
			if (!parts) return false;
			const token = actor.kind === "agent" ? await tokens.find(actor.id) : null;
			const manage =
				!!token &&
				token.status === "active" &&
				token.permissions.includes("channels:manage") &&
				(token.workspaceId ?? (await workspaces.defaultWorkspaceId())) === w;
			return channels.canReferenceMessage(
				w,
				{
					actor: { ...actor, name: actor.id },
					...(actor.kind === "agent"
						? {
								agent: { manage },
							}
						: {}),
				},
				parts[1],
				parts[2],
			);
		},
	};
}
