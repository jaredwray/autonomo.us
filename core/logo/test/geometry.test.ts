import { describe, expect, it } from "vitest";
import { buildMark, MARK_WIDTH } from "../src/geometry.js";

describe("buildMark", () => {
	it("produces the requested number of blades", () => {
		const mark = buildMark(13);
		expect(mark.blades).toHaveLength(13);
	});

	it("orders blades left-to-right with decreasing length", () => {
		const { blades } = buildMark(13);
		for (let i = 1; i < blades.length; i++) {
			expect(blades[i].anchorX).toBeGreaterThan(blades[i - 1].anchorX);
			expect(blades[i].length).toBeLessThan(blades[i - 1].length);
		}
	});

	it("places every tip above its anchor and emits closed paths", () => {
		for (const b of buildMark(20).blades) {
			expect(b.tipY).toBeLessThan(b.anchorY);
			expect(b.path.startsWith("M")).toBe(true);
			expect(b.path.endsWith("Z")).toBe(true);
		}
	});

	it("derives a sane gradient span and bounding box", () => {
		const mark = buildMark(13);
		expect(mark.gradientTop).toBeLessThan(mark.gradientBottom);
		expect(mark.bbox.minX).toBeLessThan(mark.bbox.maxX);
		expect(mark.bbox.maxX).toBeLessThanOrEqual(MARK_WIDTH);
		expect(mark.bbox.minY).toBeGreaterThanOrEqual(0);
	});

	it("never produces NaN coordinates", () => {
		const json = JSON.stringify(buildMark(7));
		expect(json).not.toContain("NaN");
	});
});
