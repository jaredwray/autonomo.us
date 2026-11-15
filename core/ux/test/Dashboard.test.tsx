import type {
	UsageAnalytics,
	UsageMetrics,
	WebAnalytics,
	WorkspaceOverview,
} from "@autonomo.us/common";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDashboardData, fetchWorkspaceOverview } from "../src/api.js";
import { analyticsCsv, Dashboard } from "../src/Dashboard.js";
import { parseDashboardTab } from "../src/dashboard-route.js";
import { attentionItems, overviewBadges } from "../src/overview-items.js";

vi.mock("../src/api.js", () => ({
	fetchDashboardData: vi.fn(),
	fetchWorkspaceOverview: vi.fn(),
	currentWorkspaceId: () => "ws-1",
}));
const WORKSPACE = {
	id: "ws-1",
	name: "Studio",
	description: "",
	isDefault: true,
	archivedAt: null,
	createdAt: "2026-11-01T00:00:00Z",
	updatedAt: "2026-11-01T00:00:00Z",
	role: "admin" as const,
};
beforeEach(() => {
	window.location.hash = "";
});
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
	window.location.hash = "";
});

const metrics: UsageMetrics = {
	requests: 10,
	errors: 0,
	promptTokens: 80,
	completionTokens: 20,
	totalTokens: 100,
	estimatedCostUsd: 0.000125,
	pricedRequests: 8,
	avgLatencyMs: 50,
};
const noWeb = (): WebAnalytics => ({
	totals: {
		fetches: 0,
		succeeded: 0,
		proxied: 0,
		cached: 0,
		costUsd: 0,
		avgLatencyMs: 0,
	},
	byCaller: [],
	byConnection: [],
	byOutcome: [],
	byHost: [],
	series: [],
});
const report = (requests = 10): UsageAnalytics => ({
	query: { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" },
	generatedAt: "2026-11-02T00:00:00Z",
	source: "mongodb",
	partial: false,
	coverageFrom: null,
	durableUnavailable: false,
	bucket: "hour",
	totals: { ...metrics, requests },
	activeCallers: 1,
	unattributedRequests: 0,
	byModel: [
		{
			...metrics,
			id: "work/model",
			name: "work/model",
			provider: "work",
			lastSeen: "2026-11-01T12:00:00Z",
		},
	],
	byProvider: [],
	byCaller: [],
	byOperation: [],
	series: [{ ...metrics, timestamp: "2026-11-01T12:00:00Z" }],
	web: noWeb(),
	options: {
		models: [{ id: "work/model", provider: "work" }],
		providers: ["work"],
		callers: [],
	},
});
const AGENT = "11111111-1111-4111-8111-111111111111";
const overview = (
	changes: Partial<WorkspaceOverview> = {},
): WorkspaceOverview => ({
	generatedAt: "2026-11-02T00:00:00Z",
	can: {
		decideProposals: true,
		manageAgents: true,
		editProxies: true,
		manageTokens: true,
		manageTeam: true,
	},
	waiting: {
		proposals: 0,
		siteRequests: [],
		proxyProblems: [],
		expiringAgents: [],
		botsAtLimit: [],
		mentions: [],
		invites: 0,
		expiringApiTokens: [],
	},
	budget: { month: "2026-11", spentUsd: 0, limitUsd: 25 },
	agents: [],
	runs: { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 },
	failedRuns: [],
	recentNotes: [],
	recentDecisions: [],
	health: { persistence: "mongodb", telemetry: "healthy", webAvailable: true },
	...changes,
});

describe("Usage tab", () => {
	beforeEach(() => {
		window.location.hash = "#/w/ws-1/dashboard/usage";
	});

	it("retains the last successful report on refresh failure and labels it stale", async () => {
		vi.mocked(fetchDashboardData)
			.mockResolvedValueOnce(report())
			.mockRejectedValueOnce(new Error("offline"));
		render(<Dashboard />);
		expect(await screen.findByText(/Durable history/)).toBeTruthy();
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Showing the last successful update",
		);
		expect(
			screen.getByRole("region", { name: "Usage totals" }).textContent,
		).toContain("100");
		expect(
			(screen.getByRole("button", { name: "Export CSV" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(fetchWorkspaceOverview).not.toHaveBeenCalled();
	});

	it("ignores late responses after a range change and does not present the old report as the new range", async () => {
		let resolveOld!: (value: UsageAnalytics) => void;
		let resolveNew!: (value: UsageAnalytics) => void;
		vi.mocked(fetchDashboardData)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveOld = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveNew = resolve;
					}),
			);
		render(<Dashboard />);
		fireEvent.change(screen.getByLabelText("Period"), {
			target: { value: "7d" },
		});
		expect(screen.queryByRole("region", { name: "Usage totals" })).toBeNull();
		resolveNew(report(27));
		await screen.findByRole("region", { name: "Usage totals" });
		resolveOld(report(999));
		await waitFor(() =>
			expect(
				screen.getByRole("region", { name: "Usage totals" }).textContent,
			).toContain("27"),
		);
		expect(
			screen.getByRole("region", { name: "Usage totals" }).textContent,
		).not.toContain("999");
	});

	it("distinguishes very small charges from free calls", async () => {
		const data = report();
		data.totals.estimatedCostUsd = 0.0000002;
		vi.mocked(fetchDashboardData).mockResolvedValue(data);
		render(<Dashboard />);
		expect(
			(await screen.findByRole("region", { name: "Usage totals" })).textContent,
		).toContain("<$0.0001");
	});

	it("names agents, links them, and shows web fetches apart from model calls", async () => {
		const data = report();
		data.byCaller = [
			{
				...metrics,
				id: `agent:${AGENT}`,
				name: "Helper",
				kind: "agent",
				lastSeen: "2026-11-01T12:00:00Z",
			},
			{
				...metrics,
				id: "agent:legacy-script",
				name: "legacy-script",
				kind: "agent",
				lastSeen: "2026-11-01T12:00:00Z",
			},
		];
		data.web = {
			...noWeb(),
			totals: {
				fetches: 4,
				succeeded: 3,
				proxied: 2,
				cached: 1,
				costUsd: 0.75,
				avgLatencyMs: 400,
			},
			byConnection: [
				{
					id: "direct",
					attempts: 3,
					succeeded: 1,
					costUsd: 0,
					lastSeen: "2026-11-01T07:00:00Z",
				},
				{
					id: "zenrows",
					attempts: 2,
					succeeded: 1,
					costUsd: 0.75,
					lastSeen: "2026-11-01T07:00:00Z",
				},
			],
			byOutcome: [
				{ id: "ok", fetches: 3 },
				{ id: "blocked", fetches: 1 },
			],
			byHost: [
				{
					id: "shop.test",
					name: "shop.test",
					fetches: 2,
					succeeded: 1,
					proxied: 2,
					cached: 0,
					costUsd: 0.75,
					avgLatencyMs: 1000,
					lastSeen: "2026-11-01T07:00:00Z",
				},
			],
		};
		vi.mocked(fetchDashboardData).mockResolvedValue(data);
		render(<Dashboard workspace={WORKSPACE} />);
		const callers = await screen.findByRole("region", {
			name: "Users & callers",
		});
		const helper = within(callers)
			.getByRole("button", { name: "Helper" })
			.closest("td") as HTMLElement;
		expect(helper.textContent).toContain("Agent");
		expect(
			within(helper)
				.getByRole("link", { name: "Open agent" })
				.getAttribute("href"),
		).toBe(`#/w/ws-1/agents/${AGENT}`);
		const legacy = within(callers)
			.getByRole("button", { name: "legacy-script" })
			.closest("td") as HTMLElement;
		expect(legacy.textContent).toContain("Reported agent ID");
		expect(within(legacy).queryByRole("link")).toBeNull();

		const web = screen.getByRole("region", { name: "Web fetches" });
		expect(
			within(web).getByText("Needed a proxy").nextSibling?.textContent,
		).toBe("50%");
		expect(
			within(web).getByRole("table", { name: "Web requests by connection" })
				.textContent,
		).toContain("Plain request");
		expect(web.textContent).toContain("Blocked by the site");
		expect(
			screen.getByRole("region", { name: "Sites fetched most" }).textContent,
		).toContain("shop.test");
	});
});

describe("analytics export", () => {
	it("exports full precision, missing-price counts, filters, and spreadsheet-safe identities", () => {
		const data = report();
		data.query.caller = "api-token:1";
		data.byCaller = [
			{
				...metrics,
				id: "api-token:1",
				name: '=HYPERLINK("bad")',
				lastSeen: "2026-11-01T12:00:00Z",
			},
		];
		const csv = analyticsCsv(data);
		expect(csv).toContain('"0.000125"');
		expect(csv).toContain('"8","2"');
		expect(csv).toContain('"api-token:1"');
		expect(csv).toContain(`"'=HYPERLINK(""bad"")"`);
	});

	it("adds web fetches by caller, site, connection, and outcome", () => {
		const data = report();
		data.web.byCaller = [
			{
				id: "user:1",
				name: "-cmd",
				kind: "user",
				fetches: 2,
				succeeded: 1,
				proxied: 1,
				cached: 0,
				costUsd: 0.5,
				avgLatencyMs: 300,
				lastSeen: "2026-11-01T07:00:00Z",
			},
		];
		data.web.byConnection = [
			{
				id: "zenrows",
				attempts: 2,
				succeeded: 1,
				costUsd: 0.5,
				lastSeen: "2026-11-01T07:00:00Z",
			},
		];
		data.web.byOutcome = [{ id: "blocked", fetches: 1 }];
		const csv = analyticsCsv(data);
		expect(csv).toContain(
			'"Web caller","user:1","\'-cmd","2","1","1","0","0.5"',
		);
		expect(csv).toContain('"Web connection","zenrows","zenrows","2","1"');
		expect(csv).toContain('"Web outcome","blocked","blocked","1"');
	});
});

describe("Overview tab", () => {
	it("opens on Overview, lists what needs the person, and links each item", async () => {
		vi.mocked(fetchDashboardData).mockResolvedValue(report());
		const seen = overview({
			waiting: {
				...overview().waiting,
				proposals: 2,
				proxyProblems: [
					{ name: "zenrows", kind: "credits", detail: "Out of credits." },
				],
				mentions: [{ channelId: "c1", name: "general", count: 1 }],
				botsAtLimit: [{ id: AGENT, name: "Helper", limit: "tokens" }],
			},
			budget: { month: "2026-11", spentUsd: 21, limitUsd: 25 },
		});
		vi.mocked(fetchWorkspaceOverview).mockResolvedValue(seen);
		const onOverview = vi.fn();
		render(<Dashboard workspace={WORKSPACE} onOverview={onOverview} />);
		const needs = await screen.findByRole("region", { name: "Needs you" });
		const links = within(needs)
			.getAllByRole("link")
			.map((link) => [link.textContent, link.getAttribute("href")]);
		// Most severe first.
		expect(links[0]?.[0]).toContain("Proxy zenrows needs attention");
		expect(links[0]?.[1]).toBe("#/w/ws-1/proxies");
		expect(links[1]?.[0]).toContain("84% of the proxy budget is spent");
		expect(links.map(([, href]) => href)).toEqual(
			expect.arrayContaining([
				"#/w/ws-1/channels/general",
				"#/w/ws-1/synapse/proposals",
				`#/w/ws-1/agents/${AGENT}`,
			]),
		);
		expect(needs.textContent).toContain("2 Synapse proposals to review");
		expect(needs.textContent).toContain("Helper reached its daily token limit");
		expect(screen.getByRole("heading", { name: "Dashboard" })).toBeDefined();
		expect(screen.getByText("Studio")).toBeDefined();
		expect(screen.getByText("Gateway healthy")).toBeDefined();
		expect(onOverview).toHaveBeenCalledWith(seen);
		expect(
			screen
				.getByRole("tab", { name: "Overview" })
				.getAttribute("aria-selected"),
		).toBe("true");
	});

	it("tells a member what waits on an admin, and says when nothing needs them", async () => {
		vi.mocked(fetchDashboardData).mockResolvedValue(report());
		vi.mocked(fetchWorkspaceOverview).mockResolvedValue(
			overview({
				can: {
					decideProposals: false,
					manageAgents: false,
					editProxies: false,
					manageTokens: false,
					manageTeam: false,
				},
				waiting: { ...overview().waiting, proposals: 1, invites: null },
			}),
		);
		render(<Dashboard workspace={{ ...WORKSPACE, role: "member" }} />);
		const needs = await screen.findByRole("region", { name: "Needs you" });
		expect(needs.textContent).toContain("Nothing needs you.");
		expect(
			within(needs).getByRole("heading", {
				name: "Waiting on a workspace admin",
			}),
		).toBeDefined();
		expect(needs.textContent).toContain("1 Synapse proposal to review");
	});

	it("shows totals, agents against their limits, spend by source, and recent news", async () => {
		const data = report();
		data.totals.estimatedCostUsd = 1.5;
		data.byProvider = [
			{
				...metrics,
				id: "anthropic",
				name: "anthropic",
				estimatedCostUsd: 1.5,
				lastSeen: "2026-11-01T12:00:00Z",
			},
		];
		data.byCaller = [
			{
				...metrics,
				id: `agent:${AGENT}`,
				name: "Helper",
				kind: "agent",
				estimatedCostUsd: 1.25,
				lastSeen: "2026-11-01T12:00:00Z",
			},
		];
		data.web = {
			...noWeb(),
			totals: { ...noWeb().totals, fetches: 4, proxied: 1, costUsd: 0.5 },
			byConnection: [
				{
					id: "zenrows",
					attempts: 1,
					succeeded: 1,
					costUsd: 0.5,
					lastSeen: "2026-11-01T07:00:00Z",
				},
			],
		};
		vi.mocked(fetchDashboardData).mockResolvedValue(data);
		vi.mocked(fetchWorkspaceOverview).mockResolvedValue(
			overview({
				agents: [
					{
						id: AGENT,
						kind: "instructions",
						name: "Helper",
						status: "active",
						model: "anthropic/claude",
						connections: 0,
						replying: true,
						replies: { used: 30, limit: 30 },
						tokens: { used: 1000, limit: 500_000 },
						expiresAt: null,
					},
				],
				runs: { pending: 0, running: 1, succeeded: 5, failed: 1, skipped: 2 },
				failedRuns: [
					{
						id: "r1",
						botId: AGENT,
						name: "Helper",
						channelId: "c1",
						detail: "The provider failed.",
						createdAt: new Date().toISOString(),
					},
				],
				recentNotes: [
					{
						title: "Brand voice",
						updatedAt: new Date().toISOString(),
						global: false,
					},
				],
			}),
		);
		render(
			<Dashboard
				workspace={WORKSPACE}
				channels={[
					{
						id: "c1",
						workspaceId: "ws-1",
						name: "film",
						topic: "",
						description: "",
						agents: [],
						createdAt: "2026-11-01T00:00:00Z",
						createdBy: { kind: "user", id: "u", name: "U" },
						updatedAt: "2026-11-01T00:00:00Z",
						archivedAt: null,
						revision: 1,
						lastMessageAt: new Date().toISOString(),
						readSeq: 0,
						unread: true,
						mentions: 0,
					},
				]}
			/>,
		);
		const totals = await screen.findByRole("region", {
			name: "Workspace totals",
		});
		await waitFor(() => expect(totals.textContent).toContain("$2.00"));
		expect(totals.textContent).toContain("$1.50 models · $0.50 proxies");
		expect(totals.textContent).toContain("6");
		expect(totals.textContent).toContain("1 failed · 2 skipped");
		expect(totals.textContent).toContain("25% needed a proxy");
		expect(totals.textContent).toContain("1 replying now");

		const agents = screen.getByRole("region", { name: "Agents" });
		expect(within(agents).getByText("Replying…")).toBeDefined();
		const replies = within(agents).getByRole("meter", {
			name: "Replies this hour",
		});
		expect(replies.getAttribute("aria-valuetext")).toBe(
			"30 of 30, at the limit",
		);
		expect(agents.textContent).toContain("$1.25");

		const spend = screen.getByRole("region", { name: "Spend by source" });
		expect(spend.textContent).toContain("anthropic");
		expect(spend.textContent).toContain("Model connection");
		expect(spend.textContent).toContain("zenrows");
		expect(
			within(spend).getByRole("meter").getAttribute("aria-valuetext"),
		).toBe("$0.00 of $25.00");

		const recent = screen.getByRole("region", { name: "Recent" });
		expect(recent.textContent).toContain("Helper could not reply in #film");
		expect(recent.textContent).toContain("#film");
		expect(
			within(recent)
				.getByRole("link", { name: "Brand voice" })
				.getAttribute("href"),
		).toBe("#/w/ws-1/synapse/shared/Brand%20voice");
	});

	it("warns about health and keeps the last overview when a refresh fails", async () => {
		vi.mocked(fetchDashboardData).mockResolvedValue(report());
		vi.mocked(fetchWorkspaceOverview)
			.mockResolvedValueOnce(
				overview({
					health: {
						persistence: "memory",
						telemetry: "failing",
						webAvailable: false,
					},
				}),
			)
			.mockRejectedValueOnce(new Error("offline"));
		render(<Dashboard workspace={WORKSPACE} />);
		expect(await screen.findByText("Usage history failing")).toBeDefined();
		expect(screen.getByText("Not saved to a database")).toBeDefined();
		expect(screen.getByText("Web access off")).toBeDefined();
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Showing the last update",
		);
		expect(screen.getByRole("region", { name: "Needs you" })).toBeDefined();
		expect(screen.getByText("Overview unavailable")).toBeDefined();
	});

	it("switches tabs in the address", async () => {
		vi.mocked(fetchDashboardData).mockResolvedValue(report());
		vi.mocked(fetchWorkspaceOverview).mockResolvedValue(overview());
		render(<Dashboard workspace={WORKSPACE} />);
		await screen.findByRole("region", { name: "Needs you" });
		fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
		expect(window.location.hash).toBe("#/w/ws-1/dashboard/usage");
		expect(
			await screen.findByRole("region", { name: "Usage totals" }),
		).toBeDefined();
		expect(parseDashboardTab("#/w/ws-1/dashboard/usage")).toBe("usage");
		expect(parseDashboardTab("#/w/ws-1/dashboard")).toBe("overview");
		expect(parseDashboardTab("#/dashboard/usage")).toBe("usage");
	});
});

describe("overview items", () => {
	it("counts only what the person can act on for the sidebar", () => {
		const waiting = {
			...overview().waiting,
			proposals: 3,
			siteRequests: [
				{ botId: "a", name: "A", count: 2 },
				{ botId: "b", name: "B", count: 1 },
			],
		};
		expect(overviewBadges(overview({ waiting }))).toEqual({
			synapse: 3,
			agents: 3,
		});
		expect(
			overviewBadges(
				overview({
					waiting,
					can: {
						...overview().can,
						decideProposals: false,
						manageAgents: false,
					},
				}),
			),
		).toEqual({ synapse: 0, agents: 0 });
		expect(overviewBadges(null)).toEqual({ synapse: 0, agents: 0 });
	});

	it("calls a spent budget used up, and leaves a zero budget alone", () => {
		const items = (spentUsd: number, limitUsd: number) =>
			attentionItems(
				overview({ budget: { month: "2026-11", spentUsd, limitUsd } }),
				"ws-1",
			).map((item) => [item.id, item.severity, item.text]);
		expect(items(25, 25)).toEqual([
			["budget", "critical", "The proxy budget for this month is used up"],
		]);
		expect(items(19, 25)).toEqual([]);
		expect(items(0, 0)).toEqual([]);
	});

	it("links expiring credentials, invites, and site requests", () => {
		const items = attentionItems(
			overview({
				waiting: {
					...overview().waiting,
					siteRequests: [{ botId: AGENT, name: "Reader", count: 1 }],
					expiringAgents: [
						{ id: AGENT, name: "Alice", expiresAt: "2026-11-20T00:00:00Z" },
					],
					expiringApiTokens: [
						{ id: "t1", name: "CI", expiresAt: "2026-11-21T00:00:00Z" },
					],
					invites: 2,
				},
			}),
			"ws 1",
		);
		expect(items.map((item) => [item.text, item.href])).toEqual([
			[
				expect.stringMatching(/^Alice's token expires /),
				`#/w/ws%201/agents/${AGENT}`,
			],
			[
				expect.stringMatching(/^API token CI expires /),
				"#/w/ws%201/api-tokens",
			],
			["Reader asked to fetch 1 new site", `#/w/ws%201/agents/${AGENT}`],
			["2 invite links not used yet", "#/team"],
		]);
	});
});
