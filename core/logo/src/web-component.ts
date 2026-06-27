import { buildSvg, resolveOptions } from "./render.js";
import type { AnimationMode, LogoOptions } from "./types.js";

// Importing the package root (e.g. for the `renderToString` SSR API) evaluates
// this module, so the base class must resolve without a DOM. In non-browser
// runtimes `HTMLElement` is undefined; fall back to a stand-in so the module
// loads. The element is only ever registered/instantiated in the browser, via
// `defineAutonomousLogo`, which guards on `customElements`.
const HTMLElementBase: typeof HTMLElement =
	typeof HTMLElement !== "undefined"
		? HTMLElement
		: (class {} as unknown as typeof HTMLElement);

/**
 * `<autonomous-logo>` custom element — the drop-anywhere wrapper.
 *
 * @example
 * ```html
 * <autonomous-logo animation="loop" speed="1.2" width="320"></autonomous-logo>
 * ```
 *
 * Attributes mirror {@link LogoOptions}: `text`, `show-wordmark`, `width`,
 * `animation`, `speed`, `streaks`, `colors` (comma-separated), `wordmark-color`,
 * `tracking`, `font-family`, `title`, `reduced-motion`.
 */
export class AutonomousLogoElement extends HTMLElementBase {
	static get observedAttributes(): string[] {
		return [
			"text",
			"show-wordmark",
			"width",
			"animation",
			"speed",
			"streaks",
			"colors",
			"wordmark-color",
			"tracking",
			"font-family",
			"title",
			"reduced-motion",
		];
	}

	private root: ShadowRoot;

	constructor() {
		super();
		this.root = this.attachShadow({ mode: "open" });
	}

	connectedCallback(): void {
		this.render();
	}

	attributeChangedCallback(): void {
		if (this.isConnected) {
			this.render();
		}
	}

	/** Restart the intro animation. */
	replay(): void {
		this.render();
	}

	private optionsFromAttributes(): LogoOptions {
		const attr = (name: string): string | null => this.getAttribute(name);
		const num = (name: string): number | undefined => {
			const v = attr(name);
			if (v === null || v.trim() === "") {
				return undefined;
			}
			const n = Number(v);
			return Number.isFinite(n) ? n : undefined;
		};
		const bool = (name: string, fallback: boolean): boolean => {
			const v = attr(name);
			if (v === null) {
				return fallback;
			}
			return v !== "false" && v !== "0";
		};
		const colors = attr("colors");
		return {
			text: attr("text") ?? undefined,
			showWordmark: bool("show-wordmark", true),
			width: num("width"),
			animation: (attr("animation") as AnimationMode | null) ?? undefined,
			speed: num("speed"),
			streaks: num("streaks"),
			colors: colors
				? colors
						.split(",")
						.map((c) => c.trim())
						.filter(Boolean)
				: undefined,
			wordmarkColor: attr("wordmark-color") ?? undefined,
			tracking: num("tracking"),
			fontFamily: attr("font-family") ?? undefined,
			title: attr("title") ?? undefined,
			respectReducedMotion: bool("reduced-motion", true),
		};
	}

	private render(): void {
		const opts = resolveOptions(this.optionsFromAttributes());
		const { svg, ratio } = buildSvg(opts);
		const sizing = opts.width
			? `width:${opts.width}px;height:${Math.round(opts.width / ratio)}px`
			: "width:100%;height:auto";
		this.root.innerHTML = `<style>:host{display:inline-block;line-height:0;background:transparent;${sizing}}svg{display:block;width:100%;height:100%}</style>${svg}`;
	}
}

/**
 * Register the custom element (idempotent). Call once during app start-up.
 *
 * @param tag - Custom element tag name. Defaults to `autonomous-logo`.
 */
export function defineAutonomousLogo(tag = "autonomous-logo"): void {
	if (typeof customElements === "undefined") {
		return;
	}
	if (!customElements.get(tag)) {
		customElements.define(tag, AutonomousLogoElement);
	}
}
