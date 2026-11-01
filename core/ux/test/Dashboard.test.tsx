import type { UsageAnalytics, UsageMetrics } from "@autonomo.us/common";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { fetchDashboardData } from "../src/api.js";
import { analyticsCsv, Dashboard } from "../src/Dashboard.js";

vi.mock("../src/api.js", () => ({ fetchDashboardData: vi.fn() }));
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
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
const report = (requests = 10): UsageAnalytics => ({
	query: { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" },
	generatedAt: "2026-11-02T00:00:00Z",
	source: "clickhouse",
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
	options: {
		models: [{ id: "work/model", provider: "work" }],
		providers: ["work"],
		callers: [],
	},
});

it("retains the last successful report on refresh failure and labels it stale", async () => {
	vi.mocked(fetchDashboardData)
		.mockResolvedValueOnce(report())
		.mockRejectedValueOnce(new Error("offline"));
	render(<Dashboard />);
	await screen.findByRole("region", { name: "Usage totals" });
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

it("distinguishes very small charges from free calls", async () => {
	const data = report();
	data.totals.estimatedCostUsd = 0.0000002;
	vi.mocked(fetchDashboardData).mockResolvedValue(data);
	render(<Dashboard />);
	expect(
		(await screen.findByRole("region", { name: "Usage totals" })).textContent,
	).toContain("<$0.0001");
});
