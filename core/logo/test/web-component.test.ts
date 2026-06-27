import { beforeEach, describe, expect, it } from "vitest";
import {
	AutonomousLogoElement,
	defineAutonomousLogo,
} from "../src/web-component.js";

describe("defineAutonomousLogo", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("registers the custom element idempotently", () => {
		defineAutonomousLogo();
		defineAutonomousLogo();
		expect(customElements.get("autonomous-logo")).toBe(AutonomousLogoElement);
	});

	it("renders an SVG into its shadow root on connect", () => {
		defineAutonomousLogo();
		const el = document.createElement("autonomous-logo");
		document.body.appendChild(el);
		expect(el.shadowRoot).not.toBeNull();
		const shadow = el.shadowRoot as ShadowRoot;
		expect(shadow.innerHTML).toContain("<svg");
		expect(shadow.innerHTML).toContain("background:transparent");
	});

	it("maps attributes onto options", () => {
		defineAutonomousLogo();
		const el = document.createElement("autonomous-logo");
		el.setAttribute("text", "NODE");
		el.setAttribute("show-wordmark", "true");
		el.setAttribute("colors", "#111111, #222222");
		document.body.appendChild(el);
		const html = (el.shadowRoot as ShadowRoot).innerHTML;
		expect(html).toContain("#111111");
		expect(html).toContain(">N</tspan>");
	});

	it('renders a static logo when animated="false"', () => {
		defineAutonomousLogo();
		const el = document.createElement("autonomous-logo");
		el.setAttribute("animated", "false");
		document.body.appendChild(el);
		const html = (el.shadowRoot as ShadowRoot).innerHTML;
		expect(html).toContain("<svg");
		expect(html).not.toContain("animation-delay");
	});

	it("re-renders when an observed attribute changes", () => {
		defineAutonomousLogo();
		const el = document.createElement(
			"autonomous-logo",
		) as AutonomousLogoElement;
		document.body.appendChild(el);
		el.setAttribute("text", "X");
		expect((el.shadowRoot as ShadowRoot).innerHTML).toContain(">X</tspan>");
		expect(typeof el.replay).toBe("function");
	});
});
