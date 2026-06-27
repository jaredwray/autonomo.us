/**
 * Public configuration for the AUTONOMOUS animated logo.
 *
 * Every option is optional; sensible, on-brand defaults are applied by
 * {@link resolveOptions}. The rendered output always has a transparent
 * background so the mark can be dropped onto any surface.
 */
export type LogoOptions = {
	/**
	 * The wordmark rendered beneath the aurora mark. Defaults to
	 * `"AUTONOMO.US"`. Set to an empty string to render the mark alone.
	 */
	text?: string;
	/**
	 * Whether to render the wordmark at all. Defaults to `true`. When
	 * `false`, only the animated aurora mark is drawn.
	 */
	showWordmark?: boolean;
	/**
	 * Pixel width of the rendered logo. Height is derived from the aspect
	 * ratio so the artwork is never distorted. When omitted the logo scales
	 * to fill its container (`width: 100%`).
	 */
	width?: number;
	/**
	 * Animation behaviour after the one-shot intro completes.
	 * - `"loop"` (default): the mark stays alive with a subtle aurora idle.
	 * - `"once"`: play the intro once, then hold the final frame.
	 * - `"none"`: render the resting frame with no motion.
	 */
	animation?: AnimationMode;
	/**
	 * Global speed multiplier. `1` is the tuned default; `2` is twice as
	 * fast, `0.5` half speed. Clamped to a sane range.
	 */
	speed?: number;
	/**
	 * Number of aurora streaks that make up the mark. Defaults to `13`,
	 * matching the reference artwork. Clamped to `5..40`.
	 */
	streaks?: number;
	/**
	 * Ordered gradient colour stops (top → bottom of the mark). Defaults to
	 * the signature cyan → blue → violet → magenta aurora ramp.
	 */
	colors?: string[];
	/**
	 * Wordmark colour. Defaults to a near-white (`#F4F7FF`).
	 */
	wordmarkColor?: string;
	/**
	 * Letter-spacing for the wordmark, in `em`. Defaults to `0.34`.
	 */
	tracking?: number;
	/**
	 * Font stack for the wordmark. Defaults to a thin geometric system sans.
	 */
	fontFamily?: string;
	/**
	 * Accessible label applied to the root SVG (`role="img"`). Defaults to a
	 * description derived from {@link LogoOptions.text}.
	 */
	title?: string;
	/**
	 * When `true` (default) the animation is automatically disabled for
	 * visitors who request reduced motion via `prefers-reduced-motion`.
	 */
	respectReducedMotion?: boolean;
};

export type AnimationMode = "loop" | "once" | "none";

/** Fully-resolved options with all defaults applied. */
export type ResolvedOptions = Required<Omit<LogoOptions, "width" | "title">> & {
	width: number | null;
	title: string;
};
