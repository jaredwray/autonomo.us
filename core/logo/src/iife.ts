/**
 * Standalone build entry for plain `<script>` usage.
 *
 * Bundled as an IIFE that exposes the whole API on `window.AutonomousLogo`
 * and auto-registers the `<autonomous-logo>` custom element, so a page can
 * use the logo with zero build tooling:
 *
 * ```html
 * <script src="autonomous-logo.iife.js"></script>
 * <autonomous-logo animation="loop"></autonomous-logo>
 * <div id="brand"></div>
 * <script>AutonomousLogo.createLogo("#brand", { width: 320 })</script>
 * ```
 */
import { defineAutonomousLogo } from "./web-component.js";

export * from "./index.js";

// Side effect: register the element automatically for script-tag consumers.
defineAutonomousLogo();
