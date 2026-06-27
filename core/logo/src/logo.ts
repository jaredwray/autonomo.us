import { buildSvg, resolveOptions } from "./render.js";
import type { LogoOptions } from "./types.js";

/**
 * Render the logo to a standalone SVG string. Use this for SSR, static-site
 * output, e-mail, or anywhere you need markup rather than a live DOM node.
 * The string is fully self-contained (scoped styles, transparent background).
 */
export function renderToString(options: LogoOptions = {}): string {
	return buildSvg(resolveOptions(options)).svg;
}

type Target = string | Element;

function resolveTarget(target: Target): Element {
	const el =
		typeof target === "string" ? document.querySelector(target) : target;
	if (!el) {
		throw new Error(
			`AutonomousLogo: target ${typeof target === "string" ? `"${target}"` : ""} not found`,
		);
	}
	return el;
}

/**
 * A mounted, controllable logo instance.
 *
 * @example
 * ```ts
 * const logo = new AutonomousLogo("#brand", { animation: "loop" });
 * logo.replay();
 * ```
 */
export class AutonomousLogo {
	readonly host: Element;
	private options: LogoOptions;
	private svgEl: SVGElement | null = null;

	constructor(target: Target, options: LogoOptions = {}) {
		this.host = resolveTarget(target);
		this.options = { ...options };
		this.render();
	}

	/** The live root `<svg>` element, or `null` before first render. */
	get element(): SVGElement | null {
		return this.svgEl;
	}

	/** Replace the current options and re-render (restarts the animation). */
	update(options: LogoOptions): this {
		this.options = { ...this.options, ...options };
		this.render();
		return this;
	}

	/** Restart the intro animation from the first frame. */
	replay(): this {
		this.render();
		return this;
	}

	/** Remove the logo from the DOM. */
	destroy(): void {
		if (this.svgEl && this.svgEl.parentNode === this.host) {
			this.host.removeChild(this.svgEl);
		}
		this.svgEl = null;
	}

	private render(): void {
		const { svg } = buildSvg(resolveOptions(this.options));
		// Parsing into a fresh node (rather than reusing) restarts CSS
		// animations deterministically across replay()/update().
		const tpl = document.createElement("template");
		tpl.innerHTML = svg.trim();
		const next = tpl.content.firstElementChild as SVGElement | null;
		if (!next) {
			return;
		}
		if (this.svgEl) {
			this.host.replaceChild(next, this.svgEl);
		} else {
			this.host.appendChild(next);
		}
		this.svgEl = next;
	}
}

/**
 * Convenience factory mirroring {@link AutonomousLogo}.
 *
 * @example
 * ```ts
 * createLogo("#brand", { width: 320 });
 * ```
 */
export function createLogo(
	target: Target,
	options: LogoOptions = {},
): AutonomousLogo {
	return new AutonomousLogo(target, options);
}
