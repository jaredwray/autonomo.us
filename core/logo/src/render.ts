import { buildMark, MARK_WIDTH } from "./geometry.js";
import type { LogoOptions, ResolvedOptions } from "./types.js";

/** Signature aurora ramp: cyan → blue → violet → magenta. */
export const DEFAULT_COLORS = ["#2AD6FF", "#3B82F6", "#7C3AED", "#C026D3"];

const DEFAULTS = {
	text: "AUTONOMO.US",
	showWordmark: true,
	animated: true,
	animation: "loop",
	speed: 1,
	streaks: 13,
	colors: DEFAULT_COLORS,
	wordmarkColor: "#F4F7FF",
	tracking: 0.34,
	fontFamily:
		'"Helvetica Neue", "Segoe UI", Inter, system-ui, -apple-system, Arial, sans-serif',
	respectReducedMotion: true,
} as const;

const clamp = (n: number, lo: number, hi: number): number =>
	Math.min(hi, Math.max(lo, n));
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Apply on-brand defaults and clamp values into safe ranges. */
export function resolveOptions(options: LogoOptions = {}): ResolvedOptions {
	const text = options.text ?? DEFAULTS.text;
	// `animated: false` is a hard off-switch and wins over `animation`.
	const animated = options.animated ?? DEFAULTS.animated;
	return {
		text,
		showWordmark: options.showWordmark ?? DEFAULTS.showWordmark,
		animated,
		animation: !animated ? "none" : (options.animation ?? DEFAULTS.animation),
		speed: clamp(options.speed ?? DEFAULTS.speed, 0.1, 5),
		streaks: clamp(Math.round(options.streaks ?? DEFAULTS.streaks), 5, 40),
		colors:
			options.colors && options.colors.length >= 2
				? options.colors
				: DEFAULTS.colors,
		wordmarkColor: options.wordmarkColor ?? DEFAULTS.wordmarkColor,
		tracking: clamp(options.tracking ?? DEFAULTS.tracking, 0, 1.5),
		fontFamily: options.fontFamily ?? DEFAULTS.fontFamily,
		respectReducedMotion:
			options.respectReducedMotion ?? DEFAULTS.respectReducedMotion,
		width: options.width ?? null,
		title: options.title ?? (text ? `${text} logo` : "Autonomous logo"),
	};
}

const esc = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");

let counter = 0;
/** Unique id for scoping a single logo instance's styles and defs. */
export function nextUid(): string {
	counter += 1;
	const rand = Math.floor(Math.random() * 1e9).toString(36);
	return `al${counter}${rand}`;
}

const PAD_TOP = 18;
const WORDMARK_GAP = 30;
const WORDMARK_SIZE = 27;

export type BuiltSvg = {
	uid: string;
	svg: string;
	/** Intrinsic aspect ratio (width / height) of the produced viewBox. */
	ratio: number;
	viewBox: { width: number; height: number };
};

/**
 * Produce a fully self-contained, transparent, animated SVG string. The SVG
 * carries its own scoped `<style>`, so it animates as inline markup, as an
 * `<img>` source, or as a CSS background — anywhere SVG is accepted.
 */
export function buildSvg(opts: ResolvedOptions, uid = nextUid()): BuiltSvg {
	const mark = buildMark(opts.streaks);
	const { bbox } = mark;
	const bboxW = bbox.maxX - bbox.minX;
	const bboxH = bbox.maxY - bbox.minY;

	// Centre the mark horizontally and pin its top to PAD_TOP.
	const tx = (MARK_WIDTH - bboxW) / 2 - bbox.minX;
	const ty = PAD_TOP - bbox.minY;
	const markBottom = bbox.maxY + ty;

	const wordmark = opts.showWordmark && opts.text.length > 0;
	const wordBaseline = markBottom + WORDMARK_GAP;
	const vbHeight = wordmark
		? Math.round(wordBaseline + WORDMARK_SIZE * 0.32 + 8)
		: Math.round(markBottom + PAD_TOP);
	const ratio = MARK_WIDTH / vbHeight;

	const id = (p: string) => `${p}_${uid}`;
	const gradId = id("g");
	const glowId = id("glow");
	const maskId = id("m");
	const sheenId = id("s");
	const wordMaskId = id("wm");

	const stops = opts.colors
		.map((c, i) => {
			const offset =
				opts.colors.length === 1
					? 0
					: Math.round((i / (opts.colors.length - 1)) * 1000) / 10;
			return `<stop offset="${offset}%" stop-color="${escAttr(c)}"/>`;
		})
		.join("");

	const s = opts.speed;
	// Per-blade nested groups: outer sway → mid breathe/twinkle → inner ignite.
	const blades = mark.blades
		.map((b) => {
			const tm = bladeTiming(b.index, b.t, s);
			return (
				`<g class="al-sway" style="${tm}">` +
				`<g class="al-breathe">` +
				`<path class="al-blade" style="--i:${b.index}" d="${b.path}"/>` +
				`</g></g>`
			);
		})
		.join("");
	const sparks = mark.blades
		.map((b) => `<path class="al-spark" style="--i:${b.index}" d="${b.path}"/>`)
		.join("");
	const bladeMask = mark.blades.map((b) => `<path d="${b.path}"/>`).join("");

	const wordmarkSvg = wordmark
		? renderWordmark(opts, wordBaseline, sheenId, wordMaskId)
		: "";

	const styles = buildStyles(opts, uid, mark.blades.length, {
		width: bboxW,
		minX: bbox.minX,
		minY: bbox.minY,
		height: bboxH,
		baselineY: bbox.maxY,
	});

	// Honour an explicit pixel width across every entry point (string, mount,
	// and custom element); otherwise scale to fill the container.
	const sizeAttr = opts.width
		? `width="${opts.width}" height="${Math.round((opts.width / ratio) * 100) / 100}"`
		: `width="100%" height="100%"`;

	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" class="al-root" id="${uid}" ` +
		`viewBox="0 0 ${MARK_WIDTH} ${vbHeight}" ` +
		`${sizeAttr} role="img" aria-label="${escAttr(opts.title)}" ` +
		`preserveAspectRatio="xMidYMid meet" fill="none">` +
		`<title>${esc(opts.title)}</title>` +
		`<defs>` +
		`<linearGradient id="${gradId}" gradientUnits="userSpaceOnUse" ` +
		`x1="0" y1="${mark.gradientTop}" x2="0" y2="${mark.gradientBottom}">${stops}</linearGradient>` +
		`<linearGradient id="${sheenId}" x1="0" y1="0" x2="1" y2="0">` +
		`<stop offset="0%" stop-color="#fff" stop-opacity="0"/>` +
		`<stop offset="38%" stop-color="#fff" stop-opacity="0"/>` +
		`<stop offset="50%" stop-color="#fff" stop-opacity="0.85"/>` +
		`<stop offset="62%" stop-color="#fff" stop-opacity="0"/>` +
		`<stop offset="100%" stop-color="#fff" stop-opacity="0"/>` +
		`</linearGradient>` +
		`<filter id="${glowId}" x="-50%" y="-50%" width="200%" height="200%">` +
		`<feGaussianBlur stdDeviation="4.5"/></filter>` +
		`<mask id="${maskId}" maskUnits="userSpaceOnUse">` +
		`<g fill="#fff" transform="translate(${round(tx)} ${round(ty)})">${bladeMask}</g></mask>` +
		`</defs>` +
		`<style>${styles}</style>` +
		`<g class="al-mark" transform="translate(${round(tx)} ${round(ty)})">` +
		`<g class="al-glow" fill="url(#${gradId})" filter="url(#${glowId})">${bladeMask}</g>` +
		`<g class="al-blades" fill="url(#${gradId})">${blades}</g>` +
		`<g class="al-sparks" fill="#fff">${sparks}</g>` +
		`<g class="al-sheen-layer" mask="url(#${maskId})">` +
		`<rect class="al-sheen" x="${round(bbox.minX)}" y="${round(bbox.minY - 8)}" ` +
		`width="${round(bboxW)}" height="${round(bboxH + 16)}" fill="url(#${sheenId})"/>` +
		`</g>` +
		`</g>` +
		wordmarkSvg +
		`</svg>`;

	return { uid, svg, ratio, viewBox: { width: MARK_WIDTH, height: vbHeight } };
}

/** Deterministic per-blade idle cadences (seconds, speed-adjusted) + seeds. */
function bladeTiming(i: number, t: number, speed: number): string {
	const sd = (6.0 * (0.8 + 0.5 * Math.abs(t - 0.5))) / speed;
	const bd = (3.0 + ((i * 0.37) % 0.6)) / speed;
	const td = (7 + ((i * 1.7) % 4)) / speed;
	const swayDelay = -((i * 0.18) % sd);
	const breatheDelay = -((i * 0.53) % bd);
	const twinkleDelay = -((i * 0.91) % td);
	// Alternate sway direction so neighbours lean opposite ways (curtain ripple).
	const dir = i % 2 === 0 ? 1 : -1;
	return (
		`--i:${i};` +
		`--sd:${round(sd)}s;--sdl:${round(swayDelay)}s;--dir:${dir};` +
		`--bd:${round(bd)}s;--bdl:${round(breatheDelay)}s;` +
		`--td:${round(td)}s;--tdl:${round(twinkleDelay)}s`
	);
}

function renderWordmark(
	opts: ResolvedOptions,
	baseline: number,
	sheenId: string,
	wordMaskId: string,
): string {
	const cx = MARK_WIDTH / 2;
	const common =
		`x="${cx}" y="${baseline}" text-anchor="middle" ` +
		`font-size="${WORDMARK_SIZE}" font-family="${escAttr(opts.fontFamily)}" ` +
		`font-weight="300" dominant-baseline="alphabetic"`;
	const letters = [...opts.text]
		.map(
			(ch, j) => `<tspan class="al-letter" style="--j:${j}">${esc(ch)}</tspan>`,
		)
		.join("");
	const sheenW = MARK_WIDTH * 0.7;
	return (
		`<mask id="${wordMaskId}">` +
		`<text ${common} fill="#fff" letter-spacing="${opts.tracking}em">${esc(opts.text)}</text></mask>` +
		`<text class="al-word" ${common} letter-spacing="${opts.tracking}em" ` +
		`fill="${escAttr(opts.wordmarkColor)}">${letters}</text>` +
		`<g class="al-word-sheen-layer" mask="url(#${wordMaskId})">` +
		`<rect class="al-word-sheen" x="${round(cx - sheenW)}" y="${round(baseline - WORDMARK_SIZE)}" ` +
		`width="${round(sheenW * 0.9)}" height="${WORDMARK_SIZE + 10}" fill="url(#${sheenId})"/></g>`
	);
}

type Layout = {
	width: number;
	minX: number;
	minY: number;
	height: number;
	baselineY: number;
};

/**
 * Scoped CSS for one instance. Keyframe names are suffixed with the instance
 * id so multiple logos on a page never collide. The resting state (no
 * animation applied) is the finished frame, so reduced-motion and
 * `animation: "none"` render the logo statically.
 *
 * Idle keyframes are sine-shaped (0/25/50/75/100 = 0/+a/0/−a/0) with linear
 * timing and per-blade durations + negative-delay seeds, so every element is
 * individually seam-free and the composite never visibly repeats.
 */
function buildStyles(
	opts: ResolvedOptions,
	uid: string,
	bladeCount: number,
	layout: Layout,
): string {
	const k = (name: string) => `${name}_${uid}`;
	const s = opts.speed;
	const ms = (n: number) => `${Math.round(n / s)}ms`;

	// Build: each blade draws top → bottom; a gentle apex-first cascade.
	const igniteDur = 600;
	const stagger = 42;
	const introBase = 140;
	const buildEnd = introBase + (bladeCount - 1) * stagger + igniteDur;
	// Highlight sweeps left → right once the mark has finished building.
	const highlightAt = buildEnd + 80;

	const kf = {
		ignite: k("ignite"),
		spark: k("spark"),
		sway: k("sway"),
		breathe: k("breathe"),
		twinkle: k("twinkle"),
		hue: k("hue"),
		glint: k("glint"),
		wordIn: k("wordIn"),
		letterIn: k("letterIn"),
		wordSweep: k("wordSweep"),
	};

	// Highlight band travels in user units, off-canvas at both ends so the
	// loop seam sits in empty space.
	const glintFrom = -layout.width;
	const glintTo = layout.width;

	const keyframes =
		// Build: each blade draws downward from its tip with a soft settle.
		`@keyframes ${kf.ignite}{` +
		`0%{transform:scaleY(0.02);opacity:0}` +
		`50%{opacity:1}` +
		`82%{transform:scaleY(1.04)}` +
		`100%{transform:scaleY(1);opacity:1}}` +
		// Hot-white flash as each blade finishes drawing.
		`@keyframes ${kf.spark}{` +
		`0%,62%{opacity:0}84%{opacity:0.5}100%{opacity:0}}` +
		// Idle: lateral curtain ripple (sine, seam-free).
		`@keyframes ${kf.sway}{` +
		`0%{transform:translateX(0) skewX(0deg)}` +
		`25%{transform:translateX(calc(var(--dir) * 1.8px)) skewX(calc(var(--dir) * 1.3deg))}` +
		`50%{transform:translateX(0) skewX(0deg)}` +
		`75%{transform:translateX(calc(var(--dir) * -1.8px)) skewX(calc(var(--dir) * -1.3deg))}` +
		`100%{transform:translateX(0) skewX(0deg)}}` +
		// Idle: vertical breathing + gentle opacity.
		`@keyframes ${kf.breathe}{` +
		`0%{transform:scaleY(1);opacity:1}` +
		`50%{transform:scaleY(1.04);opacity:0.9}` +
		`100%{transform:scaleY(1);opacity:1}}` +
		// Idle: arrhythmic twinkle — flat, then a brief mid-cycle flare.
		`@keyframes ${kf.twinkle}{` +
		`0%,46%{filter:brightness(1)}50%{filter:brightness(1.55)}54%,100%{filter:brightness(1)}}` +
		// Idle: slow hue drift across the whole sky.
		`@keyframes ${kf.hue}{` +
		`0%{filter:hue-rotate(-12deg)}50%{filter:hue-rotate(12deg)}100%{filter:hue-rotate(-12deg)}}` +
		// Specular highlight sweeping left → right across the mark.
		`@keyframes ${kf.glint}{` +
		`0%{transform:translateX(${round(glintFrom)}px) skewX(-8deg);opacity:0}` +
		`4%{opacity:1}15%{opacity:1}` +
		`19%{transform:translateX(${round(glintTo)}px) skewX(-8deg);opacity:0}` +
		`100%{transform:translateX(${round(glintTo)}px) skewX(-8deg);opacity:0}}` +
		// Wordmark: tracking tightens, rises, de-blurs.
		`@keyframes ${kf.wordIn}{` +
		`0%{letter-spacing:0.6em;transform:translateY(7px);filter:blur(4px)}` +
		`100%{letter-spacing:${opts.tracking}em;transform:translateY(0);filter:blur(0)}}` +
		// Wordmark: per-letter left-to-right resolve.
		`@keyframes ${kf.letterIn}{0%{opacity:0}100%{opacity:1}}` +
		`@keyframes ${kf.wordSweep}{` +
		`0%{transform:translateX(${round(-layout.width)}px) skewX(-12deg);opacity:0}` +
		`6%{opacity:1}24%{opacity:1}` +
		`30%{transform:translateX(${round(MARK_WIDTH * 1.1)}px) skewX(-12deg);opacity:0}` +
		`100%{transform:translateX(${round(MARK_WIDTH * 1.1)}px) skewX(-12deg);opacity:0}}`;

	// Resting frame — the finished, fully-visible logo.
	const base =
		`#${uid}{display:block;overflow:visible}` +
		// Build draws from the tip downward, so blades pivot at their top edge;
		// the idle layers pivot at the base for a curtain-like sway/breathe.
		`#${uid} .al-blade{transform-box:fill-box;transform-origin:50% 0%}` +
		`#${uid} .al-sway,#${uid} .al-breathe{transform-box:fill-box;transform-origin:50% 100%}` +
		`#${uid} .al-glow{opacity:0.5}` +
		`#${uid} .al-sparks{mix-blend-mode:screen}` +
		`#${uid} .al-spark{opacity:0}` +
		`#${uid} .al-mark{transform-box:fill-box;transform-origin:50% 100%}` +
		`#${uid} .al-sheen,#${uid} .al-word-sheen{opacity:0;mix-blend-mode:screen}` +
		`#${uid} .al-word{transform-box:fill-box;transform-origin:50% 50%}` +
		`#${uid} .al-letter{opacity:1}`;

	const animate =
		opts.animation === "none"
			? false
			: opts.animation === "once"
				? "once"
				: "loop";
	if (!animate) {
		return keyframes + base;
	}
	const idle = animate === "loop";
	const iter = idle ? "infinite" : "1";

	const motion =
		// Per-blade build (top → bottom), gentle apex-first cascade.
		`#${uid} .al-blade{animation:${kf.ignite} ${ms(igniteDur)} cubic-bezier(.16,1,.3,1) both;` +
		`animation-delay:calc(${ms(introBase)} + var(--i) * ${ms(stagger)});will-change:transform,opacity}` +
		`#${uid} .al-spark{animation:${kf.spark} ${ms(igniteDur + 120)} ease-out 1 both;` +
		`animation-delay:calc(${ms(introBase)} + var(--i) * ${ms(stagger)})}` +
		// Idle layers (loop only): sway + breathe/twinkle, seeded per blade.
		(idle
			? `#${uid} .al-sway{animation:${kf.sway} var(--sd) linear infinite;animation-delay:var(--sdl)}` +
				`#${uid} .al-breathe{animation:${kf.breathe} var(--bd) linear infinite,` +
				`${kf.twinkle} var(--td) linear infinite;animation-delay:var(--bdl),var(--tdl)}` +
				`#${uid} .al-mark{animation:${kf.hue} ${ms(14000)} linear infinite}`
			: "") +
		// Highlight: a left → right sweep, fired once the build completes, then
		// repeated on a long idle cadence.
		`#${uid} .al-sheen{animation:${kf.glint} ${ms(idle ? 6600 : igniteDur * 4)} ` +
		`cubic-bezier(.22,1,.36,1) ${iter};animation-delay:${ms(highlightAt)}}`;

	const wordRules = opts.showWordmark
		? `#${uid} .al-word{animation:${kf.wordIn} ${ms(820)} cubic-bezier(.22,1,.36,1) both;` +
			`animation-delay:${ms(buildEnd * 0.62)}}` +
			`#${uid} .al-letter{animation:${kf.letterIn} ${ms(360)} ease-out both;` +
			`animation-delay:calc(${ms(buildEnd * 0.62)} + var(--j) * ${ms(52)})}` +
			`#${uid} .al-word-sheen{animation:${kf.wordSweep} ${ms(idle ? 8200 : 3000)} ease-in-out ${iter};` +
			`animation-delay:${ms(highlightAt + 200)}}`
		: "";

	const all = motion + wordRules;
	if (opts.respectReducedMotion) {
		return (
			keyframes +
			base +
			`@media (prefers-reduced-motion: no-preference){${all}}`
		);
	}
	return keyframes + base + all;
}
