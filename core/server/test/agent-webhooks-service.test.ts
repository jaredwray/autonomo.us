import { randomUUID } from "node:crypto";
import type { SynapseProposal } from "@autonomo.us/common";
import { describe, expect, it, vi } from "vitest";
import type {
	WebhookRequest,
	WebhookTransport,
} from "../src/agent-webhooks/delivery.js";
import { MemoryAgentWebhookRepository } from "../src/agent-webhooks/repository.js";
import { AgentWebhooks } from "../src/agent-webhooks/webhooks.js";

const WORKSPACE = randomUUID();

/** A proposal by `agentId`, just decided, which wakes that agent. */
const decided = (agentId: string): SynapseProposal => ({
	id: randomUUID(),
	space: "shared",
	action: "update",
	title: "Ada Lovelace",
	reason: "Fix links.",
	status: "approved",
	author: { kind: "agent", id: agentId, name: "Scout" },
	createdAt: new Date().toISOString(),
	baseRevision: 1,
	decidedAt: new Date().toISOString(),
	decidedBy: { kind: "user", id: "u1", name: "Jared" },
});

function setUp(options: {
	repository?: MemoryAgentWebhookRepository;
	agentStatus?: () => "active" | "expired" | "revoked";
	permissions?: string[];
	mayDeliverDecision?: () => Promise<boolean>;
	mayDeliverLoopAssignment?: () => Promise<boolean>;
	transport?: WebhookTransport;
	resolver?: () => Promise<Array<{ address: string; family: 4 | 6 }>>;
	log?: (message: string, details: Record<string, unknown>) => void;
}) {
	const sent: WebhookRequest[] = [];
	const transport =
		options.transport ??
		Object.assign(
			async (request: WebhookRequest) => {
				sent.push(request);
				return { status: 200, retryAfter: null };
			},
			{ pinsAddress: Boolean(options.resolver) },
		);
	const repository = options.repository ?? new MemoryAgentWebhookRepository();
	const webhooks = new AgentWebhooks({
		repository,
		agents: {
			find: async () => {
				const status = options.agentStatus?.() ?? "active";
				// A revoked agent is not found at all.
				return status === "revoked"
					? null
					: {
							name: "Scout",
							workspaceId: WORKSPACE,
							status,
							permissions: options.permissions ?? [],
						};
			},
		},
		workspaces: {
			get: async () => ({ archivedAt: null }),
			defaultWorkspaceId: async () => WORKSPACE,
		},
		threadAuthor: async () => null,
		mayDeliverDecision: options.mayDeliverDecision,
		mayDeliverLoopAssignment: options.mayDeliverLoopAssignment,
		transport,
		resolver: options.resolver,
		timing: { gapMs: 10, retryDelaysMs: [10] },
		timeoutMs: 200,
		log: options.log,
	});
	return { webhooks, repository, sent };
}

describe("agent webhook delivery in process", () => {
	it("sends metadata-only organization wakeups and rechecks the assignment before delivery", async () => {
		let authorized = true;
		const { webhooks, sent } = setUp({
			permissions: ["mcp:read", "mcp:call", "organization:decide"],
			mayDeliverDecision: async () => authorized,
		});
		try {
			const agentId = randomUUID();
			await webhooks.create(
				WORKSPACE,
				agentId,
				{ url: "https://hooks.example.com/x", events: ["organization"] },
				"Producer",
			);
			const at = new Date().toISOString();
			await webhooks.onOrganizationNotice(WORKSPACE, agentId, {
				key: "case.first",
				event: {
					type: "decision.assigned",
					at,
					caseId: "case",
					outcomeId: null,
				},
			});
			authorized = false;
			await webhooks.idle();
			expect(sent).toEqual([]);
			authorized = true;
			const notice = {
				key: "case.final",
				event: {
					type: "decision.outcome" as const,
					caseId: "case",
					outcomeId: "receipt",
					at,
				},
			};
			await webhooks.onOrganizationNotice(WORKSPACE, agentId, notice);
			await webhooks.onOrganizationNotice(WORKSPACE, agentId, notice);
			await webhooks.idle();
			expect(sent).toHaveLength(1);
			const body = JSON.parse(sent[0].body);
			expect(body.data.events).toEqual([notice.event]);
			expect(body.text).toContain("organization_read_case");
		} finally {
			await webhooks.close();
		}
	});
	it("rechecks a loop step and live action grant, sending assignment IDs once", async () => {
		const agentId = randomUUID(),
			permissions = ["mcp:read", "mcp:call", "loops:act"];
		let current = true;
		const { webhooks, sent } = setUp({
			permissions,
			mayDeliverLoopAssignment: async () => current,
		});
		try {
			await webhooks.create(
				WORKSPACE,
				agentId,
				{ url: "https://hooks.example.com/loops", events: ["loops"] },
				"Producer",
			);
			const event = {
				type: "loop.assigned" as const,
				at: new Date().toISOString(),
				loopId: "loop",
				runId: "run",
				stepIndex: 1,
			};
			current = false;
			await webhooks.onLoopAssignment(WORKSPACE, agentId, {
				key: "old",
				event,
			});
			await webhooks.idle();
			current = true;
			permissions.pop();
			await webhooks.onLoopAssignment(WORKSPACE, agentId, {
				key: "revoked",
				event,
			});
			await webhooks.idle();
			expect(sent).toHaveLength(0);
			permissions.push("loops:act");
			await webhooks.onLoopAssignment(WORKSPACE, agentId, {
				key: "ready",
				event,
			});
			await webhooks.onLoopAssignment(WORKSPACE, agentId, {
				key: "ready",
				event,
			});
			await webhooks.idle();
			expect(sent).toHaveLength(1);
			expect(JSON.parse(sent[0].body).data.events).toEqual([event]);
			expect(JSON.parse(sent[0].body).text).toContain("loops_assignments");
		} finally {
			await webhooks.close();
		}
	});
	it("logs a storage failure during a timed delivery instead of leaving it unhandled", async () => {
		const repository = new MemoryAgentWebhookRepository();
		const log = vi.fn();
		const { webhooks } = setUp({ repository, log });
		const agentId = randomUUID();
		await webhooks.create(
			WORKSPACE,
			agentId,
			{ url: "https://hooks.example.com/x" },
			"Jared",
		);
		await webhooks.onProposalDecided(WORKSPACE, decided(agentId));
		// The timer fires into a storage outage.
		vi.spyOn(repository, "get").mockRejectedValue(new Error("MongoDB down"));
		await webhooks.idle();
		expect(log).toHaveBeenCalledWith(
			"An agent webhook failed unexpectedly.",
			expect.objectContaining({ error: expect.any(Error) }),
		);
		await webhooks.close();
	});

	it("sends nothing when the webhook is paused while its host is being looked up", async () => {
		let lookedUp: () => void = () => {};
		const lookup = new Promise<void>((resolve) => {
			lookedUp = resolve;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { webhooks, sent } = setUp({
			resolver: async () => {
				lookedUp();
				await gate;
				return [{ address: "93.184.215.14", family: 4 }];
			},
		});
		const agentId = randomUUID();
		await webhooks.create(
			WORKSPACE,
			agentId,
			{ url: "https://hooks.example.com/x" },
			"Jared",
		);
		await webhooks.onProposalDecided(WORKSPACE, decided(agentId));
		await lookup;
		await webhooks.update(WORKSPACE, agentId, { enabled: false });
		release();
		await webhooks.idle();
		expect(sent).toEqual([]);
		expect(await webhooks.get(WORKSPACE, agentId)).toMatchObject({
			status: "paused",
			pendingEvents: 0,
			nextAttemptAt: null,
		});
		await webhooks.close();
	});

	it("sends nothing when the agent is revoked while its host is being looked up", async () => {
		let status: "active" | "revoked" = "active";
		let lookedUp: () => void = () => {};
		const lookup = new Promise<void>((resolve) => {
			lookedUp = resolve;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { webhooks, sent } = setUp({
			agentStatus: () => status,
			resolver: async () => {
				lookedUp();
				await gate;
				return [{ address: "93.184.215.14", family: 4 }];
			},
		});
		const agentId = randomUUID();
		await webhooks.create(
			WORKSPACE,
			agentId,
			{ url: "https://hooks.example.com/x" },
			"Jared",
		);
		await webhooks.onProposalDecided(WORKSPACE, decided(agentId));
		await lookup;
		// The token is revoked; its webhook has not been deleted yet.
		status = "revoked";
		release();
		await webhooks.idle();
		expect(sent).toEqual([]);
		await webhooks.close();
	});

	it("sends an auth key changed while the host was being looked up", async () => {
		let lookedUp: () => void = () => {};
		const lookup = new Promise<void>((resolve) => {
			lookedUp = resolve;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { webhooks, sent } = setUp({
			resolver: async () => {
				lookedUp();
				await gate;
				return [{ address: "93.184.215.14", family: 4 }];
			},
		});
		const agentId = randomUUID();
		await webhooks.create(
			WORKSPACE,
			agentId,
			{ url: "https://hooks.example.com/x", authKey: "old-key" },
			"Jared",
		);
		await webhooks.onProposalDecided(WORKSPACE, decided(agentId));
		await lookup;
		await webhooks.update(WORKSPACE, agentId, { authKey: "new-key" });
		release();
		await webhooks.idle();
		expect(sent.map((request) => request.headers.authorization)).toEqual([
			"Bearer new-key",
		]);
		await webhooks.close();
	});

	it("stops waiting for a host lookup that never answers", async () => {
		const { webhooks, sent } = setUp({
			resolver: () => new Promise(() => {}),
		});
		const agentId = randomUUID();
		await webhooks.create(
			WORKSPACE,
			agentId,
			{ url: "https://hooks.example.com/x" },
			"Jared",
		);
		const started = Date.now();
		expect(await webhooks.test(WORKSPACE, agentId, "Jared")).toMatchObject({
			ok: false,
			error: "timeout",
		});
		expect(Date.now() - started).toBeLessThan(2000);
		expect(sent).toEqual([]);
		await webhooks.close();
	});
});
