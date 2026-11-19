import { randomUUID } from "node:crypto";
import type {
	AgentTokenSecret,
	DecisionCase,
	OrgActorRef,
	OrgPosition,
} from "@autonomo.us/common";
import type { createServer } from "../../src/server.js";

type Gateway = Pick<ReturnType<typeof createServer>, "inject">;
export const continuityRequest = {
	decisionKey: "visual-continuity",
	sourceWorkId: "rustboy/shot-014",
	sourceRevision: "cut-3",
	question: "May I switch this shot to reference B?",
	evidence: [
		{ label: "Rejected cut", ref: "work:rustboy/shot-014/cut-3" },
		{ label: "Proposed reference B", ref: "work:rustboy/references/B" },
	],
};

/** Runs only when called with a fresh, in-memory development gateway. */
export async function seedRustboy(server: Gateway) {
	async function request<T>(
		method: "GET" | "POST" | "PUT" | "PATCH",
		url: string,
		token?: string,
		payload?: object,
	) {
		const reply = await server.inject({
			method,
			url,
			headers: token ? { authorization: `Bearer ${token}` } : {},
			payload,
		});
		if (reply.statusCode < 200 || reply.statusCode >= 300)
			throw new Error(
				`${method} ${url} failed (${reply.statusCode}): ${reply.body}`,
			);
		return reply.json<T>();
	}
	const email = "producer@rustboy.example";
	const password = randomUUID();
	const owner = await request<{ token: string; user: { id: string } }>(
		"POST",
		"/v1/setup",
		undefined,
		{ name: "Jared", email, password },
	);
	const { workspaces } = await request<{
		workspaces: { id: string; isDefault: boolean }[];
	}>("GET", "/v1/workspaces", owner.token);
	const workspaceId = workspaces.find((w) => w.isDefault)?.id;
	if (!workspaceId) throw new Error("Default workspace is missing.");
	await request("PATCH", `/v1/workspaces/${workspaceId}`, owner.token, {
		name: "Rustboy",
		description: "Synthetic production studio",
	});
	const base = `/v1/${workspaceId}`;
	const admin = <T>(
		method: "GET" | "POST" | "PUT",
		path: string,
		payload?: object,
	) => request<T>(method, `${base}/organization${path}`, owner.token, payload);
	async function agent(name: string, decides = false) {
		const permissions = decides
			? ["mcp:read", "mcp:call", "organization:decide"]
			: ["mcp:read", "mcp:call"];
		const created = await request<AgentTokenSecret>(
			"POST",
			`${base}/agent-tokens`,
			owner.token,
			{
				name,
				description: "Synthetic Rustboy fixture",
				ttlDays: 7,
				permissions,
			},
		);
		return {
			identity: { kind: "agent" as const, id: created.token.id },
			secret: created.secret,
		};
	}
	const director = await agent("Captain", true),
		artist = await agent("Iris", true),
		editor = await agent("Splice");
	const position = (
		title: string,
		occupant: OrgActorRef,
		managerId: string | null,
		remit: string,
		authority: string,
	) =>
		admin<OrgPosition>("POST", "/positions", {
			title,
			occupant,
			managerId,
			remit,
			authority,
		});
	const jared = await position(
		"Executive Producer",
		{ kind: "user", id: owner.user.id },
		null,
		"Accountable for production.",
		"Resolve production escalations.",
	);
	const captain = await position(
		"Studio Director",
		director.identity,
		jared.id,
		"Run the studio and coordinate departments.",
		"Decide production priorities.",
	);
	const iris = await position(
		"Art Director",
		artist.identity,
		captain.id,
		"Maintain visual continuity.",
		"Approve reference changes for the specified shot revision.",
	);
	const splice = await position(
		"Shot Editor",
		editor.identity,
		captain.id,
		"Cut shots and check visual continuity.",
		"Choose cuts within the approved references.",
	);
	await admin("PUT", "/settings", {
		leadPositionId: captain.id,
		humanFallbackPositionId: jared.id,
	});
	await admin("PUT", "/rules/visual-continuity", {
		ownerPositionId: iris.id,
		fallbackPositionIds: [jared.id],
		deadlineMinutes: 30,
		expectedVersion: 0,
	});

	async function tool<T>(secret: string, name: string, args: object = {}) {
		const reply = await request<{
			result?: {
				isError?: boolean;
				content: { text: string }[];
				structuredContent: T;
			};
			error?: { message: string };
		}>("POST", "/mcp", secret, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		});
		if (reply.error || !reply.result || reply.result.isError)
			throw new Error(
				reply.error?.message ??
					reply.result?.content[0]?.text ??
					"MCP tool failed.",
			);
		return reply.result.structuredContent;
	}
	const open = () =>
		tool<DecisionCase>(editor.secret, "organization_open_case", {
			...continuityRequest,
			requesterPositionId: splice.id,
		});
	return {
		workspaceId,
		email,
		password,
		owner,
		admin,
		tool,
		open,
		director,
		artist,
		editor,
		captain,
		splice,
		iris,
		jared,
	};
}
