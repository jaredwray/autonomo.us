import { beforeEach, describe, expect, it } from "vitest";
import { AutonomousLogo, createLogo, renderToString } from "../src/logo.js";

describe("renderToString", () => {
	it("returns a self-contained SVG string", () => {
		const svg = renderToString({ animation: "none" });
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg).toContain("AUTONOMO.US");
	});
});

describe("AutonomousLogo", () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="host"></div>';
	});

	it("mounts an SVG into the target element", () => {
		const logo = new AutonomousLogo("#host");
		const host = document.getElementById("host") as HTMLElement;
		expect(host.querySelector("svg")).not.toBeNull();
		expect(logo.element?.tagName.toLowerCase()).toBe("svg");
	});

	it("accepts an element reference as the target", () => {
		const host = document.getElementById("host") as HTMLElement;
		const logo = new AutonomousLogo(host);
		expect(logo.host).toBe(host);
	});

	it("throws for a missing target", () => {
		expect(() => new AutonomousLogo("#nope")).toThrow(/not found/);
	});

	it("replay keeps exactly one SVG mounted", () => {
		const logo = new AutonomousLogo("#host");
		logo.replay();
		expect(document.querySelectorAll("#host svg")).toHaveLength(1);
	});

	it("update re-renders with new options", () => {
		const logo = new AutonomousLogo("#host", { text: "ALPHA" });
		logo.update({ text: "BETA" });
		expect(logo.element?.outerHTML).toContain(">B</tspan>");
		expect(logo.element?.outerHTML).not.toContain(">L</tspan>");
	});

	it("destroy removes the SVG", () => {
		const logo = new AutonomousLogo("#host");
		logo.destroy();
		expect(document.querySelector("#host svg")).toBeNull();
		expect(logo.element).toBeNull();
	});

	it("createLogo is equivalent to the constructor", () => {
		const logo = createLogo("#host");
		expect(logo).toBeInstanceOf(AutonomousLogo);
	});
});
