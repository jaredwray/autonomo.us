import { describe, expect, it } from "vitest";
import {
	createGraphLayout,
	type GraphLayout,
	nodeRadius,
	seedPosition,
	settle,
	starfield,
} from "../src/synapse-graph-layout.js";

const distance = (layout: GraphLayout, a: number, b: number) =>
	Math.hypot(layout.x[a] - layout.x[b], layout.y[a] - layout.y[b]);
const finite = (layout: GraphLayout) =>
	[...layout.x, ...layout.y].every(Number.isFinite);

describe("Synapse graph layout", () => {
	it("starts from the titles, so the same graph always lays out the same", () => {
		expect(seedPosition("Ada Lovelace", 10)).toEqual(
			seedPosition("Ada Lovelace", 10),
		);
		expect(seedPosition("Ada Lovelace", 10)).not.toEqual(
			seedPosition("Grace Hopper", 10),
		);
		const ids = ["Ada", "Babbage", "Engine", "Hopper", "COBOL"];
		const links: Array<[number, number]> = [
			[0, 1],
			[0, 2],
			[3, 4],
		];
		const first = createGraphLayout(ids, links);
		const second = createGraphLayout(ids, links);
		settle(first);
		settle(second);
		expect([...first.x]).toEqual([...second.x]);
		expect([...first.y]).toEqual([...second.y]);
	});

	it("settles in a bounded number of steps and then stays still", () => {
		const layout = createGraphLayout(
			["a", "b", "c"],
			[
				[0, 1],
				[1, 2],
			],
		);
		let steps = 1;
		while (layout.tick()) steps++;
		expect(steps).toBeGreaterThan(50);
		expect(steps).toBeLessThanOrEqual(300);
		const rest = [...layout.x, ...layout.y];
		expect(layout.tick()).toBe(false);
		expect([...layout.x, ...layout.y]).toEqual(rest);
	});

	it("draws linked notes together and keeps unlinked ones apart", () => {
		// Two pairs and a loner: three disconnected components.
		const layout = createGraphLayout(
			["a1", "a2", "b1", "b2", "loner"],
			[
				[0, 1],
				[2, 3],
			],
		);
		settle(layout);
		expect(finite(layout)).toBe(true);
		const linked = Math.max(distance(layout, 0, 1), distance(layout, 2, 3));
		for (const [a, b] of [
			[0, 2],
			[0, 3],
			[1, 2],
			[1, 3],
			[0, 4],
			[1, 4],
			[2, 4],
			[3, 4],
		])
			expect(distance(layout, a, b)).toBeGreaterThan(linked);
		// Gravity keeps the components in one view.
		expect(Math.max(...[...layout.x, ...layout.y].map(Math.abs))).toBeLessThan(
			200,
		);
	});

	it("spreads a hub's leaves around it without overlap", () => {
		const leaves = 40;
		const ids = [
			"hub",
			...Array.from({ length: leaves }, (_, n) => `leaf ${n}`),
		];
		const layout = createGraphLayout(
			ids,
			ids.slice(1).map((_, n): [number, number] => [0, n + 1]),
		);
		settle(layout);
		expect(finite(layout)).toBe(true);
		for (let a = 0; a < ids.length; a++)
			for (let b = a + 1; b < ids.length; b++)
				expect(distance(layout, a, b)).toBeGreaterThan(nodeRadius(1) * 2);
	});

	it("handles no nodes, one node, and nodes that start on one spot", () => {
		const empty = createGraphLayout([], []);
		settle(empty);
		expect(empty.x).toHaveLength(0);
		const one = createGraphLayout(["only"], []);
		settle(one);
		expect(distance(one, 0, 0)).toBe(0);
		// Gravity brings a lone node to the centre.
		expect(Math.hypot(one.x[0], one.y[0])).toBeLessThan(1);
		const stacked = createGraphLayout(["a", "b", "c"], [[0, 1]], () => ({
			x: 5,
			y: 5,
		}));
		settle(stacked);
		expect(finite(stacked)).toBe(true);
		expect(distance(stacked, 0, 1)).toBeGreaterThan(10);
		expect(distance(stacked, 0, 2)).toBeGreaterThan(10);
	});

	it("holds a pinned node in place and lets it go again", () => {
		const layout = createGraphLayout(["a", "b"], [[0, 1]]);
		settle(layout);
		layout.pin(0, { x: 300, y: -40 });
		expect([layout.x[0], layout.y[0]]).toEqual([300, -40]);
		// A settled layout wakes so the neighbour follows.
		expect(layout.tick()).toBe(false);
		layout.reheat();
		settle(layout);
		expect([layout.x[0], layout.y[0]]).toEqual([300, -40]);
		expect(distance(layout, 0, 1)).toBeLessThan(100);
		layout.pin(0, null);
		layout.reheat();
		settle(layout);
		// Released, it drifts back toward the centre.
		expect(Math.hypot(layout.x[0], layout.y[0])).toBeLessThan(200);
	});

	it("scatters the same background stars every time, evenly and mostly faint", () => {
		const stars = starfield(200, 400);
		expect(starfield(200, 400)).toEqual(stars);
		for (const star of stars) {
			expect(star.x).toBeGreaterThanOrEqual(0);
			expect(star.x).toBeLessThanOrEqual(400);
			expect(star.y).toBeGreaterThanOrEqual(0);
			expect(star.y).toBeLessThanOrEqual(400);
			expect(star.radius).toBeGreaterThanOrEqual(0.4);
			expect(star.radius).toBeLessThanOrEqual(1.3);
		}
		// No empty quarter, and no rows: x says little about y.
		for (const [left, top] of [
			[true, true],
			[true, false],
			[false, true],
			[false, false],
		]) {
			const inQuarter = stars.filter(
				(star) => star.x < 200 === left && star.y < 200 === top,
			);
			expect(inQuarter.length).toBeGreaterThan(30);
		}
		const mean = (values: number[]) =>
			values.reduce((sum, value) => sum + value, 0) / values.length;
		const mx = mean(stars.map((star) => star.x));
		const my = mean(stars.map((star) => star.y));
		const covariance = mean(stars.map((s) => (s.x - mx) * (s.y - my)));
		const spread = (pick: (s: (typeof stars)[number]) => number, m: number) =>
			Math.sqrt(mean(stars.map((s) => (pick(s) - m) ** 2)));
		expect(
			Math.abs(covariance / (spread((s) => s.x, mx) * spread((s) => s.y, my))),
		).toBeLessThan(0.2);
		expect(stars.filter((star) => star.opacity < 0.5).length).toBeGreaterThan(
			100,
		);
	});

	it("sizes nodes by the square root of their links, within limits", () => {
		expect(nodeRadius(0)).toBe(4);
		expect(nodeRadius(4)).toBe(7);
		expect(nodeRadius(4)).toBeGreaterThan(nodeRadius(1));
		expect(nodeRadius(10_000)).toBe(16);
	});
});
