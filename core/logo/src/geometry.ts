/**
 * Generative geometry for the aurora "A" mark.
 *
 * The mark is a triangle of slim, sharp-tipped "blades" (aurora light beams).
 * Tips ride the right-leaning hypotenuse from the apex down to the right foot,
 * while their bottoms sit along the base from the left foot to the right foot.
 * Blade 0 is the tall left leg (apex → left foot); each successive blade steps
 * right, shortens, and its tip descends — so the silhouette reads as a clean,
 * wide letter "A".
 *
 * All coordinates live in the SVG user space defined by {@link MARK_WIDTH} /
 * {@link MARK_HEIGHT}. Nothing here knows about animation or colour; it
 * produces pure path data plus the per-blade anchor metadata the renderer
 * needs to stagger motion.
 */

/** Width of the mark's coordinate space. */
export const MARK_WIDTH = 440;
/** Height of the mark's coordinate space. */
export const MARK_HEIGHT = 270;

// Triangle corners — a wide, balanced "A".
const APEX = { x: 218, y: 16 };
const LEFT_FOOT = { x: 64, y: 250 };
const RIGHT_FOOT = { x: 372, y: 250 };

export type Blade = {
	/** Left-to-right index, `0` is the tall apex/left-leg blade. */
	index: number;
	/** Normalised position across the fan, `0..1`. */
	t: number;
	/** SVG path describing the blade outline. */
	path: string;
	/** Bottom anchor — sits on the base line. */
	anchorX: number;
	anchorY: number;
	/** Sharp tip coordinates — ride the hypotenuse. */
	tipX: number;
	tipY: number;
	/** Spine length, used to scale per-blade timing and glow. */
	length: number;
};

export type MarkGeometry = {
	blades: Blade[];
	/** Vertical span of the shared gradient (cyan at `top`, magenta at `bottom`). */
	gradientTop: number;
	gradientBottom: number;
	/** Tight bounding box of all blades. */
	bbox: { minX: number; minY: number; maxX: number; maxY: number };
};

const round = (n: number): number => Math.round(n * 100) / 100;
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

/**
 * Build the triangular fan of blades for `count` streaks. Shape is expressed
 * as smooth functions of the fan parameter so the mark stays balanced for any
 * blade count.
 */
export function buildMark(count: number): MarkGeometry {
	const n = Math.max(2, Math.floor(count));
	const blades: Blade[] = [];

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (let i = 0; i < n; i++) {
		// `i/n` (not `i/(n-1)`) keeps the right-most blade a short sliver rather
		// than collapsing it onto the right foot.
		const u = i / n;
		const t = n === 1 ? 0 : i / (n - 1);

		const tipX = lerp(APEX.x, RIGHT_FOOT.x, u);
		const tipY = lerp(APEX.y, RIGHT_FOOT.y, u);
		const anchorX = lerp(LEFT_FOOT.x, RIGHT_FOOT.x, u);
		const anchorY = lerp(LEFT_FOOT.y, RIGHT_FOOT.y, u);
		const length = Math.hypot(anchorX - tipX, anchorY - tipY);

		// Slim throughout; a hair wider for the tall left blades.
		const halfWidth = 1.0 + 2.3 * (1 - u);

		blades.push({
			index: i,
			t: round(t),
			path: bladePath(tipX, tipY, anchorX, anchorY, halfWidth),
			anchorX: round(anchorX),
			anchorY: round(anchorY),
			tipX: round(tipX),
			tipY: round(tipY),
			length: round(length),
		});

		minX = Math.min(minX, tipX - halfWidth, anchorX - halfWidth);
		maxX = Math.max(maxX, tipX + halfWidth, anchorX + halfWidth);
		minY = Math.min(minY, tipY);
		maxY = Math.max(maxY, anchorY);
	}

	return {
		blades,
		gradientTop: round(minY),
		gradientBottom: round(maxY),
		bbox: {
			minX: round(minX),
			minY: round(minY),
			maxX: round(maxX),
			maxY: round(maxY),
		},
	};
}

/**
 * One blade: a clean lens that is sharp at the tip, widest ~55% of the way
 * down the spine, and tapers to a soft point at the anchor.
 */
function bladePath(
	tipX: number,
	tipY: number,
	anchorX: number,
	anchorY: number,
	halfWidth: number,
): string {
	const dx = anchorX - tipX;
	const dy = anchorY - tipY;
	const len = Math.hypot(dx, dy) || 1;
	const ux = dx / len;
	const uy = dy / len;
	const px = -uy;
	const py = ux;

	const at = (s: number, o: number): [number, number] => [
		round(tipX + dx * s + px * o),
		round(tipY + dy * s + py * o),
	];

	const widest = 0.55;
	const [tx, ty] = [round(tipX), round(tipY)];
	const [wrx, wry] = at(widest, halfWidth);
	const [wlx, wly] = at(widest, -halfWidth);
	const [bx, by] = [round(anchorX), round(anchorY)];

	const [c1x, c1y] = at(0.22, halfWidth * 0.7);
	const [c2x, c2y] = at(0.85, halfWidth * 0.34);
	const [c3x, c3y] = at(0.85, -halfWidth * 0.34);
	const [c4x, c4y] = at(0.22, -halfWidth * 0.7);

	return (
		`M${tx} ${ty}` +
		`Q${c1x} ${c1y} ${wrx} ${wry}` +
		`Q${c2x} ${c2y} ${bx} ${by}` +
		`Q${c3x} ${c3y} ${wlx} ${wly}` +
		`Q${c4x} ${c4y} ${tx} ${ty}` +
		"Z"
	);
}
