import type { AnalyticsBreakdown, UsageAnalytics } from "@autonomo.us/common";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCurrentWorkspace } from "../src/api.js";
import { ModelUsageChart, USAGE_TOP } from "../src/ModelUsageChart.js";

// The LLM tab's usage chart against a stubbed analytics endpoint.

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function row(
	id: string,
	overrides: Partial<AnalyticsBreakdown> = {},
): AnalyticsBreakdown {
	return {
		id,
		name: id,
		provider: id.split("/")[0],
		requests: 1,
		errors: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		estimatedCostUsd: 0,
		pricedRequests: 0,
		lastSeen: "2026-11-20T00:00:00.000Z",
		...overrides,
	};
}
function analytics(
	byModel: AnalyticsBreakdown[],
	overrides: Partial<UsageAnalytics> = {},
): UsageAnalytics {
	const sum = (key: keyof AnalyticsBreakdown) =>
		byModel.reduce((total, item) => total + (item[key] as number), 0);
	return {
		query: { from: "", to: "" },
		generatedAt: "2026-11-20T00:00:00.000Z",
		source: "mongodb",
		coverageFrom: null,
		partial: false,
		durableUnavailable: false,
		bucket: "day",
		totals: {
			requests: sum("requests"),
			errors: 0,
			promptTokens: sum("promptTokens"),
			completionTokens: sum("completionTokens"),
			totalTokens: sum("totalTokens"),
			estimatedCostUsd: sum("estimatedCostUsd"),
			pricedRequests: sum("pricedRequests"),
		},
		activeCallers: 0,
		unattributedRequests: 0,
		byModel,
		byProvider: [],
		byCaller: [],
		byOperation: [],
		series: [],
		web: {} as UsageAnalytics["web"],
		options: { models: [], providers: [], callers: [] },
		...overrides,
	} as UsageAnalytics;
}

/** Answers each analytics read with the next of `answers`; the last repeats. */
function stub(answers: Array<UsageAnalytics | "fail">) {
	const urls: URL[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = new URL(
			String(input instanceof Request ? input.url : input),
			"http://localhost",
		);
		urls.push(url);
		const answer = answers[Math.min(urls.length - 1, answers.length - 1)];
		return answer === "fail"
			? new Response("{}", { status: 503 })
			: new Response(JSON.stringify(answer), {
					headers: { "content-type": "application/json" },
				});
	});
	return urls;
}
const bars = () =>
	within(screen.getByRole("list")).getAllByRole("listitem") as HTMLElement[];
const names = () =>
	bars().map((item) => item.querySelector(".name")?.textContent);
const values = () =>
	bars().map((item) => item.querySelector(".value")?.textContent);

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("Usage by model", () => {
	it("ranks the last 30 days' models by tokens, calls, or spend", async () => {
		setCurrentWorkspace(WORKSPACE);
		const urls = stub([
			analytics([
				row("openai/gpt-alpha", {
					requests: 3,
					promptTokens: 9_000,
					completionTokens: 3_000,
					totalTokens: 12_000,
					estimatedCostUsd: 0.5,
					pricedRequests: 3,
				}),
				row("anthropic/claude-opus", {
					requests: 9,
					promptTokens: 1_000,
					completionTokens: 1_000,
					totalTokens: 2_000,
					estimatedCostUsd: 2,
					pricedRequests: 9,
				}),
				row("local/free", { requests: 5, totalTokens: 500 }),
			]),
		]);
		render(<ModelUsageChart />);
		await screen.findByRole("list", { name: "Tokens by model, last 30 days" });
		const url = urls[0];
		expect(url.pathname).toBe(`/v1/${WORKSPACE}/telemetry/analytics`);
		const from = Date.parse(url.searchParams.get("from") ?? "");
		const to = Date.parse(url.searchParams.get("to") ?? "");
		expect(Math.round((to - from) / 86_400_000)).toBe(30);
		expect(names()).toEqual([
			"openai/gpt-alpha",
			"anthropic/claude-opus",
			"local/free",
		]);
		expect(values()).toEqual(["12K", "2,000", "500"]);
		// Tokens split into prompt and completion; a model that reports only a total does not.
		expect(bars()[0].querySelectorAll(".segment")).toHaveLength(2);
		expect(bars()[2].querySelectorAll(".segment")).toHaveLength(1);
		expect(screen.getByText("Prompt")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Calls" }));
		expect(
			screen
				.getByRole("button", { name: "Calls" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(names()).toEqual([
			"anthropic/claude-opus",
			"local/free",
			"openai/gpt-alpha",
		]);
		expect(screen.queryByText("Prompt")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Spend" }));
		// A model without a list price shows no spend and ranks last.
		expect(names()).toEqual([
			"anthropic/claude-opus",
			"openai/gpt-alpha",
			"local/free",
		]);
		expect(values()).toEqual(["$2.00", "$0.50", "—"]);
		expect(screen.getByText(/Spend counts priced calls only/)).toBeDefined();
		expect(
			screen.getByRole("link", { name: "See all usage" }).getAttribute("href"),
		).toBe(`#/w/${WORKSPACE}/dashboard/usage`);
	});

	it(`shows the top ${USAGE_TOP} and counts the rest`, async () => {
		stub([
			analytics(
				Array.from({ length: USAGE_TOP + 3 }, (_, index) =>
					row(`p/model-${index}`, { totalTokens: 1000 - index }),
				),
			),
		]);
		render(<ModelUsageChart />);
		await screen.findByRole("list");
		expect(bars()).toHaveLength(USAGE_TOP);
		expect(screen.getByText(/And 3 more models/)).toBeDefined();
	});

	it("says when nothing has called a model", async () => {
		stub([analytics([])]);
		render(<ModelUsageChart />);
		expect(
			await screen.findByText("No model calls in the last 30 days"),
		).toBeDefined();
		expect(screen.queryByRole("button", { name: "Tokens" })).toBeNull();
	});

	it("fails on its own and reads again on Retry", async () => {
		stub([
			"fail",
			analytics([row("openai/gpt-alpha", { totalTokens: 10 })], {
				partial: true,
				source: "memory",
				coverageFrom: "2026-11-19T00:00:00.000Z",
			}),
		]);
		render(<ModelUsageChart />);
		expect(await screen.findByText(/Usage could not be loaded/)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await screen.findByRole("list");
		expect(names()).toEqual(["openai/gpt-alpha"]);
		expect(screen.getByText(/earlier calls may be missing/)).toBeDefined();
	});

	it("reads again when asked, keeping what it showed if that read fails", async () => {
		stub([analytics([row("openai/gpt-alpha", { totalTokens: 10 })]), "fail"]);
		const { rerender } = render(<ModelUsageChart refreshKey={0} />);
		await screen.findByRole("list");
		rerender(<ModelUsageChart refreshKey={1} />);
		expect(
			await screen.findByText(/Usage could not be refreshed/),
		).toBeDefined();
		expect(names()).toEqual(["openai/gpt-alpha"]);
	});
});
