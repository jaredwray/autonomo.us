/**
 * `@autonomo.us/logo` — the animated AUTONOMOUS aurora logo.
 *
 * Dependency-free and framework-agnostic. Three ways to use it:
 *
 * 1. SSR / static string:   `renderToString(options)`
 * 2. Imperative DOM mount:   `new AutonomousLogo(target, options)`
 * 3. Custom element:         `defineAutonomousLogo()` → `<autonomous-logo>`
 *
 * The output always has a transparent background.
 */

export { AutonomousLogo, createLogo, renderToString } from "./logo.js";
export type { BuiltSvg } from "./render.js";
export { buildSvg, DEFAULT_COLORS, resolveOptions } from "./render.js";
export type {
	AnimationMode,
	LogoOptions,
	ResolvedOptions,
} from "./types.js";
export {
	AutonomousLogoElement,
	defineAutonomousLogo,
} from "./web-component.js";
