import { describe, expect, it } from "vitest";
import { buildSvg, DEFAULT_COLORS, resolveOptions } from "../src/render.js";

const count = (haystack: string, needle: string): number =>
	haystack.split(needle).length - 1;

describe("resolveOptions", () => {
	it("applies on-brand defaults", () => {
		const o = resolveOptions();
		expect(o.text).toBe("AUTONOMOUS");
		expect(o.streaks).toBe(13);
		expect(o.speed).toBe(1);
		expect(o.colors).toEqual(DEFAULT_COLORS);
		expect(o.title).toBe("AUTONOMOUS logo");
	});

	it("clamps out-of-range values", () => {
		expect(resolveOptions({ speed: 99 }).speed).toBe(5);
		expect(resolveOptions({ speed: 0 }).speed).toBe(0.1);
		expect(resolveOptions({ streaks: 1 }).streaks).toBe(5);
		expect(resolveOptions({ streaks: 999 }).streaks).toBe(40);
	});

	it("ignores a single-colour palette and keeps the default", () => {
		expect(resolveOptions({ colors: ["#fff"] }).colors).toEqual(DEFAULT_COLORS);
	});
});

describe("buildSvg", () => {
	it("emits a transparent, self-contained, accessible SVG", () => {
		const { svg, viewBox, ratio } = buildSvg(resolveOptions());
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg).toContain('fill="none"');
		expect(svg).toContain('role="img"');
		expect(svg).toContain("<style>");
		expect(svg).toContain("linearGradient");
		expect(svg).not.toContain('<rect class="al-bg"');
		expect(viewBox.width).toBe(440);
		expect(ratio).toBeGreaterThan(0);
	});

	it("renders one blade path per streak", () => {
		expect(
			count(buildSvg(resolveOptions({ streaks: 13 })).svg, 'class="al-blade"'),
		).toBe(13);
		expect(
			count(buildSvg(resolveOptions({ streaks: 22 })).svg, 'class="al-blade"'),
		).toBe(22);
	});

	it("renders the wordmark as per-letter tspans, or omits it", () => {
		const withWord = buildSvg(resolveOptions({ text: "AUTONOMOUS" })).svg;
		expect(count(withWord, "<tspan")).toBe(10);
		const without = buildSvg(resolveOptions({ showWordmark: false })).svg;
		expect(without).not.toContain("<tspan");
		expect(without).not.toContain("<text");
	});

	it("scopes ids per instance so two logos never collide", () => {
		const a = buildSvg(resolveOptions());
		const b = buildSvg(resolveOptions());
		expect(a.uid).not.toBe(b.uid);
		expect(a.svg).toContain(a.uid);
		expect(b.svg).not.toContain(a.uid);
	});

	it("omits motion rules when animation is disabled", () => {
		expect(buildSvg(resolveOptions({ animation: "none" })).svg).not.toContain(
			"animation-delay",
		);
		expect(buildSvg(resolveOptions({ animation: "loop" })).svg).toContain(
			"animation-delay",
		);
	});

	it("gates motion behind prefers-reduced-motion by default", () => {
		expect(buildSvg(resolveOptions()).svg).toContain("prefers-reduced-motion");
		expect(
			buildSvg(resolveOptions({ respectReducedMotion: false })).svg,
		).not.toContain("prefers-reduced-motion");
	});

	it("honours a custom palette", () => {
		const svg = buildSvg(
			resolveOptions({ colors: ["#101010", "#202020", "#303030"] }),
		).svg;
		expect(svg).toContain("#101010");
		expect(svg).toContain("#303030");
	});

	it("honours an explicit pixel width on the root svg", () => {
		const { svg, ratio } = buildSvg(resolveOptions({ width: 320 }));
		expect(svg).toContain('width="320"');
		expect(svg).not.toContain('width="100%"');
		const h = Math.round((320 / ratio) * 100) / 100;
		expect(svg).toContain(`height="${h}"`);
	});

	it("fills its container when no width is given", () => {
		expect(buildSvg(resolveOptions()).svg).toContain('width="100%"');
	});

	it("escapes the font family so quotes/angles can't break the markup", () => {
		const svg = buildSvg(
			resolveOptions({ fontFamily: `My "Quote" <Font>` }),
		).svg;
		expect(svg).toContain("&quot;Quote&quot;");
		expect(svg).toContain("&lt;Font&gt;");
		expect(svg).not.toContain("<Font>");
	});
});
