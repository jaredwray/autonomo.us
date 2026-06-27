// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	AutonomousLogoElement,
	defineAutonomousLogo,
	renderToString,
} from "../src/index.js";

// Importing the package root must not require a DOM — the advertised SSR API
// has to work in Node, where `HTMLElement`/`customElements` are undefined.
describe("non-DOM runtime (SSR)", () => {
	it("runs in an environment without a DOM", () => {
		expect(typeof HTMLElement).toBe("undefined");
		expect(typeof customElements).toBe("undefined");
	});

	it("imports and renders to a string without throwing", () => {
		const svg = renderToString({ animation: "loop", width: 240 });
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg).toContain("AUTONOMO.US");
		expect(svg).toContain('width="240"');
	});

	it("exposes the element class and a no-op define()", () => {
		expect(typeof AutonomousLogoElement).toBe("function");
		expect(() => defineAutonomousLogo()).not.toThrow();
	});
});
