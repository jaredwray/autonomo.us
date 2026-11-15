/**
 * A small force-directed layout for the Synapse graph: nodes repel each
 * other, links pull their ends together, and everything is drawn toward the
 * centre so unlinked notes stay in view. It starts from positions derived
 * from the titles, never from chance, so a space looks the same on every
 * load. Repulsion compares every pair, which is fine up to the server's cap.
 */

export type Point = { x: number; y: number };

export type GraphLayout = {
	/** Positions by node index, updated in place by `tick`. */
	readonly x: Float64Array;
	readonly y: Float64Array;
	/** Advances one step. False once the layout has settled. */
	tick(): boolean;
	/** Holds a node at a point until it is released with `null`. */
	pin(index: number, point: Point | null): void;
	/** Wakes a settled layout so the nodes around a moved one follow it. */
	reheat(): void;
};

/** Length a link rests at, before repulsion stretches it. */
const LINK_DISTANCE = 60;
/** Push between two nodes, falling off with distance. */
const REPULSION = 400;
/** Pull toward the centre, growing with distance. */
const GRAVITY = 0.06;
/** Share of its velocity a node keeps each step. */
const DAMPING = 0.6;
/** Forces scale with alpha, which decays to a stop in about 300 steps. */
const ALPHA_MIN = 0.001;
const ALPHA_DECAY = 1 - ALPHA_MIN ** (1 / 300);
const REHEAT_ALPHA = 0.3;
/** Nodes closer than this repel as if this far apart, so none is flung away. */
const MIN_DISTANCE = 4;
/** Spacing of the starting disc. */
const SEED_SPACING = 20;

/** FNV-1a: a stable 32-bit hash of a title. */
function hash(text: string) {
	let value = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		value ^= text.charCodeAt(index);
		value = Math.imul(value, 0x01000193);
	}
	return value >>> 0;
}

/** Where a node starts: a spot on a disc that grows with the node count, chosen by its title. */
export function seedPosition(id: string, count: number): Point {
	const value = hash(id);
	const angle = ((value & 0xffff) / 0x10000) * 2 * Math.PI;
	const radius =
		Math.sqrt((value >>> 16) / 0x10000) * SEED_SPACING * Math.sqrt(count);
	return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export type BackgroundStar = {
	x: number;
	y: number;
	radius: number;
	opacity: number;
};

/**
 * The stars behind the graph: `count` points in a square of side `size`,
 * most of them small and faint. Hashed from their index, like the seeds, so
 * the sky is the same on every load.
 */
export function starfield(count: number, size: number): BackgroundStar[] {
	// FNV alone leaves the x and y of one star correlated, which draws the
	// stars in rows; murmur3's final mix spreads them.
	const unit = (index: number, channel: number) => {
		let value = hash(`star ${index * 4 + channel}`);
		value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
		value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
		return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
	};
	return Array.from({ length: count }, (_, index) => {
		// Squared, so bright stars are rare.
		const brightness = unit(index, 2) ** 2;
		return {
			x: Math.round(unit(index, 0) * size * 10) / 10,
			y: Math.round(unit(index, 1) * size * 10) / 10,
			radius: Math.round((0.4 + brightness * 0.9) * 100) / 100,
			opacity: Math.round((0.3 + brightness * 0.65) * 100) / 100,
		};
	});
}

/** A node's radius: grows with the square root of its links, within limits. */
export const nodeRadius = (degree: number) =>
	Math.min(16, 4 + 1.5 * Math.sqrt(degree));

/**
 * `links` are pairs of indexes into `ids`. `start` places a node somewhere
 * other than its seed, such as where the previous layout left it.
 */
export function createGraphLayout(
	ids: readonly string[],
	links: ReadonlyArray<readonly [number, number]>,
	start?: (id: string) => Point | undefined,
): GraphLayout {
	const count = ids.length;
	const x = new Float64Array(count);
	const y = new Float64Array(count);
	const vx = new Float64Array(count);
	const vy = new Float64Array(count);
	const pinned = new Map<number, Point>();
	ids.forEach((id, index) => {
		const point = start?.(id) ?? seedPosition(id, count);
		x[index] = point.x;
		y[index] = point.y;
	});
	const degree = new Uint32Array(count);
	for (const [source, target] of links) {
		degree[source]++;
		degree[target]++;
	}
	let alpha = 1;

	const repel = () => {
		for (let a = 0; a < count; a++)
			for (let b = a + 1; b < count; b++) {
				let dx = x[b] - x[a];
				const dy = y[b] - y[a];
				// Two nodes on one spot have no direction to part in; give them one.
				if (dx === 0 && dy === 0) dx = 0.01;
				const push =
					(REPULSION * alpha) /
					Math.max(dx * dx + dy * dy, MIN_DISTANCE * MIN_DISTANCE);
				vx[a] -= dx * push;
				vy[a] -= dy * push;
				vx[b] += dx * push;
				vy[b] += dy * push;
			}
	};
	const pull = () => {
		for (const [source, target] of links) {
			const dx = x[target] - x[source];
			const dy = y[target] - y[source];
			const distance = Math.hypot(dx, dy);
			if (distance === 0) continue;
			// A leaf's link is stiff and a hub's many links are soft, and the
			// better-linked end moves less, so hubs do not shake.
			const strength = alpha / Math.min(degree[source], degree[target]);
			const move = ((distance - LINK_DISTANCE) / distance) * strength;
			const share = degree[source] / (degree[source] + degree[target]);
			vx[target] -= dx * move * share;
			vy[target] -= dy * move * share;
			vx[source] += dx * move * (1 - share);
			vy[source] += dy * move * (1 - share);
		}
	};
	const hold = () => {
		for (const [index, point] of pinned) {
			x[index] = point.x;
			y[index] = point.y;
			vx[index] = 0;
			vy[index] = 0;
		}
	};

	return {
		x,
		y,
		tick() {
			if (alpha < ALPHA_MIN) return false;
			repel();
			pull();
			for (let index = 0; index < count; index++) {
				vx[index] = (vx[index] - x[index] * GRAVITY * alpha) * DAMPING;
				vy[index] = (vy[index] - y[index] * GRAVITY * alpha) * DAMPING;
				x[index] += vx[index];
				y[index] += vy[index];
			}
			hold();
			alpha -= alpha * ALPHA_DECAY;
			return alpha >= ALPHA_MIN;
		},
		pin(index, point) {
			if (point) pinned.set(index, point);
			else pinned.delete(index);
			hold();
		},
		reheat() {
			alpha = Math.max(alpha, REHEAT_ALPHA);
		},
	};
}

/** Runs a layout to rest in one go, for people who asked for less motion. */
export function settle(layout: GraphLayout) {
	while (layout.tick());
}
