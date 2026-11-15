import {
	SYNAPSE_GLOBAL_SPACE,
	SYNAPSE_SHARED_SPACE,
	type SynapseGraph as SynapseGraphData,
	type SynapseGraphNode,
} from "@autonomo.us/common";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { fetchSynapseGraph } from "./api.js";
import { Icon } from "./Icons.js";
import {
	createGraphLayout,
	type GraphLayout,
	nodeRadius,
	type Point,
	settle,
	starfield,
} from "./synapse-graph-layout.js";
import { noteHash } from "./synapse-route.js";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
/** Fit-to-view stops here, so a few notes are not blown up to fill the panel. */
const FIT_ZOOM = 1.6;
/** From this zoom every node is labelled; below it only the best-linked are. */
const LABEL_ZOOM = 0.9;
const MAJOR_LABELS = 12;
/** On a narrow screen, zoomed out, only this many keep their label. */
const LEAD_LABELS = 4;
const ZOOM_STEP = 1.3;
/** Space kept around the graph when fitting, for the labels under the nodes; at most a tenth of the canvas. */
const FIT_MARGIN = 40;
/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD = 4;
const LABEL_LENGTH = 32;
/** Expanded, the canvas is never shorter than this, however small the window. */
const EXPANDED_MIN_HEIGHT = 320;

/** How far the glow around a note reaches, in radii. */
const HALO = 3;
/** The background sky: one tile of stars, repeated, plus a few that twinkle. */
const SKY_TILE = 480;
const SKY_STARS = starfield(110, SKY_TILE);
const TWINKLERS = starfield(12, 720);
/** Background stars move this much of a pan, so they read as far away. */
const SKY_PARALLAX = 0.25;
const STAR_GRADIENT = "synapse-graph-star";
const CATEGORY_GRADIENT = "synapse-graph-star-category";

/** Better-linked notes glow brighter: 0.5 for a note with no links, 1 from 16. */
const haloOpacity = (degree: number) =>
	0.5 + 0.5 * Math.min(1, Math.sqrt(degree) / 4);

const count = (value: number, noun: string) =>
	`${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;
const shortLabel = (title: string) =>
	title.length > LABEL_LENGTH ? `${title.slice(0, LABEL_LENGTH - 1)}…` : title;

/** The nodes on screen, with links and neighbours as indexes into them. */
function arrange(graph: SynapseGraphData, showUnresolved: boolean) {
	const visible = graph.nodes.filter((node) => showUnresolved || node.exists);
	const indexOf = new Map(visible.map((node, index) => [node.title, index]));
	const links: Array<[number, number]> = [];
	const neighbours = visible.map(() => new Set<number>());
	for (const edge of graph.edges) {
		const source = indexOf.get(edge.source);
		const target = indexOf.get(edge.target);
		if (source === undefined || target === undefined) continue;
		links.push([source, target]);
		neighbours[source].add(target);
		neighbours[target].add(source);
	}
	// Counted again, so hidden unresolved links do not size, rank, or describe a note.
	const nodes = visible.map((node, index) => ({
		...node,
		degree: neighbours[index].size,
	}));
	// A note is a category when another note's `categories` names it.
	const categories = new Set(
		graph.nodes.flatMap((node) =>
			node.categories.map((category) => category.toLowerCase()),
		),
	);
	// Labelled even when zoomed out, best-linked first.
	const ranked = nodes
		.map((node, index) => ({ index, degree: node.degree }))
		.filter((item) => item.degree > 0)
		.sort((a, b) => b.degree - a.degree || a.index - b.index)
		.map((item) => item.index);
	const major = new Set(ranked.slice(0, MAJOR_LABELS));
	const lead = new Set(ranked.slice(0, LEAD_LABELS));
	return { nodes, indexOf, links, neighbours, categories, major, lead };
}

/**
 * What the drawing code needs outside React: positions change every frame,
 * so they are written straight to the elements instead of re-rendering.
 */
type Stage = {
	svg: SVGSVGElement;
	viewport: SVGGElement;
	/** The background layers that follow the view at a distance. */
	sky: Element[];
	titles: string[];
	layout: GraphLayout;
	links: Array<[number, number]>;
	radii: number[];
	nodes: SVGGElement[];
	lines: SVGLineElement[];
	/** Screen = graph × k + (x, y). */
	view: { x: number; y: number; k: number };
	/** Keep the whole graph in view until the person pans or zooms. */
	auto: boolean;
	frame: number;
	reducedMotion: boolean;
};

const round = (value: number) => Math.round(value * 10) / 10;

function paint({ layout, nodes, lines, links }: Stage) {
	const { x, y } = layout;
	nodes.forEach((node, index) => {
		node.setAttribute(
			"transform",
			`translate(${round(x[index])} ${round(y[index])})`,
		);
	});
	lines.forEach((line, index) => {
		const [source, target] = links[index];
		line.setAttribute("x1", String(round(x[source])));
		line.setAttribute("y1", String(round(y[source])));
		line.setAttribute("x2", String(round(x[target])));
		line.setAttribute("y2", String(round(y[target])));
	});
}

function applyView({ svg, viewport, sky, view }: Stage) {
	viewport.setAttribute(
		"transform",
		`translate(${round(view.x)} ${round(view.y)}) scale(${view.k})`,
	);
	const far = `translate(${round(view.x * SKY_PARALLAX)} ${round(view.y * SKY_PARALLAX)}) scale(${1 + (view.k - 1) * 0.08})`;
	for (const layer of sky)
		layer.setAttribute(
			layer.localName === "pattern" ? "patternTransform" : "transform",
			far,
		);
	// Labels and strokes divide by this to stay one size on screen.
	svg.style.setProperty("--graph-zoom", String(view.k));
	svg.toggleAttribute("data-zoomed", view.k >= LABEL_ZOOM);
}

/** The drawing area in pixels; jsdom reports none, so tests get a stand-in. */
function sizeOf(svg: SVGSVGElement) {
	const rect = svg.getBoundingClientRect();
	return { width: rect.width || 800, height: rect.height || 560, rect };
}

function fit(stage: Stage) {
	const { x, y } = stage.layout;
	if (!x.length) return;
	let left = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	stage.radii.forEach((radius, index) => {
		left = Math.min(left, x[index] - radius);
		right = Math.max(right, x[index] + radius);
		top = Math.min(top, y[index] - radius);
		bottom = Math.max(bottom, y[index] + radius);
	});
	const { width, height } = sizeOf(stage.svg);
	const margin = Math.min(FIT_MARGIN, width / 10, height / 10);
	const k = Math.min(
		FIT_ZOOM,
		Math.max(
			MIN_ZOOM,
			Math.min(
				(width - 2 * margin) / (right - left),
				(height - 2 * margin) / (bottom - top),
			),
		),
	);
	stage.view = {
		k,
		x: width / 2 - (k * (left + right)) / 2,
		y: height / 2 - (k * (top + bottom)) / 2,
	};
	applyView(stage);
}

/** Zooms by `factor`, keeping the point at (x, y) pixels where it is. */
function zoomAt(stage: Stage, factor: number, x: number, y: number) {
	const { view } = stage;
	const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
	const ratio = k / view.k;
	stage.view = {
		k,
		x: x - (x - view.x) * ratio,
		y: y - (y - view.y) * ratio,
	};
	stage.auto = false;
	applyView(stage);
}

/** Animates the layout until it settles; a no-op while it is already running. */
function run(stage: Stage) {
	if (stage.frame) return;
	const step = () => {
		const moving = stage.layout.tick();
		paint(stage);
		if (stage.auto) fit(stage);
		stage.frame = moving ? requestAnimationFrame(step) : 0;
	};
	stage.frame = requestAnimationFrame(step);
}

const indexAt = (target: EventTarget) => {
	const node = (target as Element).closest("[data-index]");
	return node ? Number(node.getAttribute("data-index")) : -1;
};

/**
 * Obsidian's graph view for one space: notes are dots sized by how many
 * links they have, links are lines, and link targets with no note yet are
 * hollow. The notes list beside it reaches every note without the graph.
 */
export function SynapseGraph({
	space,
	version,
	spaceName,
	canEdit,
	current,
	expanded,
	onExpandedChange,
	onOpen,
	onNewNote,
}: {
	space: string;
	/** Shown in the header while expanded, when the space picker is hidden. */
	spaceName: string;
	/**
	 * "Full screen": the parent hides the notes column and the canvas fills
	 * the window below the page header. The app navigation stays.
	 */
	expanded: boolean;
	onExpandedChange(expanded: boolean): void;
	/** Bumped by the parent when notes changed, so the graph is read again. */
	version: number;
	/** False where the viewer may only read, such as Global for members. */
	canEdit: boolean;
	/** The note the viewer just came from, ringed so they keep their place. */
	current: string | null;
	onOpen(title: string): void;
	/** Opens the New note form prefilled with an unresolved link's title. */
	onNewNote(title: string): void;
}) {
	const [graph, setGraph] = useState<SynapseGraphData | null>(null);
	const [error, setError] = useState("");
	const [showUnresolved, setShowUnresolved] = useState(true);
	const [hovered, setHovered] = useState<string | null>(null);
	const [focused, setFocused] = useState<string | null>(null);
	const sequence = useRef(0);
	const containerRef = useRef<HTMLDivElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const viewportRef = useRef<SVGGElement>(null);
	const stageRef = useRef<Stage | null>(null);
	const press = useRef<{
		pointer: number;
		node: number;
		x: number;
		y: number;
		moved: boolean;
	} | null>(null);
	/** A drag ends in a click on the same element; that click opens nothing. */
	const dragged = useRef(false);

	const load = useCallback(async () => {
		const request = ++sequence.current;
		try {
			const result = await fetchSynapseGraph(space);
			if (request !== sequence.current) return;
			setGraph(result);
			setError("");
		} catch (cause) {
			if (request === sequence.current)
				setError(
					cause instanceof Error ? cause.message : "Could not load the graph.",
				);
		}
	}, [space]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` reloads after notes changed
	useEffect(() => {
		void load();
		return () => {
			sequence.current++;
		};
	}, [load, version]);

	const shown = useMemo(
		() => (graph ? arrange(graph, showUnresolved) : null),
		[graph, showUnresolved],
	);
	const drawn = Boolean(shown?.nodes.length);

	// A new layout for each set of nodes, starting where the last one left
	// those it shares, so hiding unresolved links does not reshuffle the rest.
	useLayoutEffect(() => {
		const svg = svgRef.current;
		const viewport = viewportRef.current;
		if (!shown || !svg || !viewport) return;
		const previous = stageRef.current;
		const left = new Map<string, Point>(
			previous?.titles.map((title, index) => [
				title,
				{ x: previous.layout.x[index], y: previous.layout.y[index] },
			]),
		);
		const titles = shown.nodes.map((node) => node.title);
		const stage: Stage = {
			svg,
			viewport,
			sky: Array.from(svg.querySelectorAll("[data-sky]")),
			titles,
			layout: createGraphLayout(titles, shown.links, (title) =>
				left.get(title),
			),
			links: shown.links,
			radii: shown.nodes.map((node) => nodeRadius(node.degree)),
			nodes: Array.from(viewport.querySelectorAll<SVGGElement>("[data-index]")),
			lines: Array.from(viewport.querySelectorAll("line")),
			view: previous?.view ?? { x: 0, y: 0, k: 1 },
			auto: previous?.auto ?? true,
			frame: 0,
			// Guarded: jsdom has no matchMedia.
			reducedMotion:
				window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
				false,
		};
		stageRef.current = stage;
		if (stage.reducedMotion) settle(stage.layout);
		paint(stage);
		if (stage.auto) fit(stage);
		else applyView(stage);
		if (!stage.reducedMotion) run(stage);
		return () => {
			cancelAnimationFrame(stage.frame);
			stage.frame = 0;
		};
	}, [shown]);

	// React's wheel handler is passive, and zooming must stop the page scrolling.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `drawn` re-attaches when the canvas appears
	useEffect(() => {
		const svg = svgRef.current;
		if (!svg) return;
		const wheel = (event: WheelEvent) => {
			const stage = stageRef.current;
			if (!stage) return;
			event.preventDefault();
			const { rect } = sizeOf(svg);
			// Firefox reports lines, not pixels.
			const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
			zoomAt(
				stage,
				Math.exp(-delta * 0.002),
				event.clientX - rect.left,
				event.clientY - rect.top,
			);
		};
		svg.addEventListener("wheel", wheel, { passive: false });
		// Guarded: jsdom has no ResizeObserver.
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(() => {
						const stage = stageRef.current;
						if (stage?.auto) fit(stage);
					});
		observer?.observe(svg);
		return () => {
			svg.removeEventListener("wheel", wheel);
			observer?.disconnect();
		};
	}, [drawn]);

	// Expanded, the canvas takes what is left of the window below its top
	// edge, which only a measurement knows; the page then needs no scrolling.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `graph` and `drawn` change what sits above the canvas
	useLayoutEffect(() => {
		const svg = svgRef.current;
		if (!svg) return;
		const page = svg.closest(".dashboard") ?? containerRef.current;
		const resize = () => {
			if (expanded) {
				const rect = svg.getBoundingClientRect();
				// What the page keeps under the canvas: the legend and the padding.
				const below = (page?.getBoundingClientRect().bottom ?? 0) - rect.bottom;
				const height = window.innerHeight - (rect.top + window.scrollY) - below;
				svg.style.height = `${Math.max(EXPANDED_MIN_HEIGHT, Math.floor(height))}px`;
			} else svg.style.removeProperty("height");
			const stage = stageRef.current;
			if (stage?.auto) fit(stage);
		};
		resize();
		if (!expanded) return;
		window.addEventListener("resize", resize);
		// A panel opening or closing above the graph, such as New note or
		// Import, moves it without resizing the window: measure again on the
		// next frame. The height does not depend on itself, so this settles.
		let frame = 0;
		const observer =
			typeof ResizeObserver === "undefined" || !page
				? null
				: new ResizeObserver(() => {
						cancelAnimationFrame(frame);
						frame = requestAnimationFrame(resize);
					});
		if (page) observer?.observe(page);
		return () => {
			window.removeEventListener("resize", resize);
			observer?.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [expanded, drawn, graph]);

	const activate = (node: SynapseGraphNode) => {
		if (node.exists) onOpen(node.title);
		else if (canEdit) onNewNote(node.title);
	};
	const pointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
		dragged.current = false;
		if (event.button !== 0) return;
		press.current = {
			pointer: event.pointerId,
			node: indexAt(event.target),
			x: event.clientX,
			y: event.clientY,
			moved: false,
		};
	};
	const pointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
		const stage = stageRef.current;
		const held = press.current;
		if (!stage || !held || held.pointer !== event.pointerId) return;
		if (!held.moved) {
			if (
				Math.hypot(event.clientX - held.x, event.clientY - held.y) <
				DRAG_THRESHOLD
			)
				return;
			held.moved = true;
			stage.auto = false;
			// Captured only once it is a drag, so a plain click still reaches
			// the node's link. Guarded: jsdom has no pointer capture.
			stage.svg.setPointerCapture?.(event.pointerId);
		}
		if (held.node < 0) {
			stage.view.x += event.clientX - held.x;
			stage.view.y += event.clientY - held.y;
			held.x = event.clientX;
			held.y = event.clientY;
			applyView(stage);
			return;
		}
		const { rect } = sizeOf(stage.svg);
		stage.layout.pin(held.node, {
			x: (event.clientX - rect.left - stage.view.x) / stage.view.k,
			y: (event.clientY - rect.top - stage.view.y) / stage.view.k,
		});
		if (stage.reducedMotion) paint(stage);
		else {
			stage.layout.reheat();
			run(stage);
		}
	};
	const pointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
		const stage = stageRef.current;
		const held = press.current;
		if (!held || held.pointer !== event.pointerId) return;
		press.current = null;
		dragged.current = held.moved;
		// With motion, a dropped node settles back among its neighbours, as
		// in Obsidian; without, it stays where it was put.
		if (stage && held.moved && held.node >= 0 && !stage.reducedMotion)
			stage.layout.pin(held.node, null);
	};
	const zoom = (factor: number) => {
		const stage = stageRef.current;
		if (!stage) return;
		const { width, height } = sizeOf(stage.svg);
		zoomAt(stage, factor, width / 2, height / 2);
	};

	const active = hovered ?? focused;
	const activeIndex = active === null ? -1 : (shown?.indexOf.get(active) ?? -1);
	const currentKey = current?.toLowerCase();
	const inheritedHere = (node: SynapseGraphNode) =>
		space === SYNAPSE_SHARED_SPACE && node.space === SYNAPSE_GLOBAL_SPACE;
	const near = (index: number) =>
		index === activeIndex ||
		Boolean(shown?.neighbours[activeIndex]?.has(index));

	const fullScreenToggle = (
		<button
			type="button"
			className="icon-button"
			aria-label={expanded ? "Exit full screen" : "Full screen"}
			title={expanded ? "Exit full screen" : "Full screen"}
			onClick={() => onExpandedChange(!expanded)}
		>
			<Icon name={expanded ? "exit-fullscreen" : "fullscreen"} />
		</button>
	);
	// Expanded, the notes column is hidden, so the way out stays even when
	// there is nothing to draw, the graph is loading, or it failed to load.
	const exitOnly = expanded && (
		<div className="synapse-graph-header">
			<h2>Graph · {spaceName}</h2>
			<div className="synapse-graph-controls">{fullScreenToggle}</div>
		</div>
	);
	if (error && !graph)
		return (
			<>
				{exitOnly}
				<div className="banner-error" role="alert">
					{error}{" "}
					<button className="button" type="button" onClick={() => void load()}>
						Retry
					</button>
				</div>
			</>
		);
	if (!graph || !shown)
		return (
			<>
				{exitOnly}
				<p className="empty-state" role="status">
					Loading graph…
				</p>
			</>
		);
	const notes = graph.nodes.filter((node) => node.exists).length;
	const hasUnresolved = notes < graph.nodes.length;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Esc from anywhere in the graph leaves full screen
		<div
			ref={containerRef}
			className={`synapse-graph${expanded ? " is-expanded" : ""}`}
			onKeyDown={(event) => {
				if (expanded && event.key === "Escape") onExpandedChange(false);
			}}
		>
			<div className="synapse-graph-header">
				<h2>
					Graph
					{/* The space picker is hidden while expanded. */}
					{expanded && ` · ${spaceName}`}
				</h2>
				{(drawn || expanded) && (
					<div className="synapse-graph-controls">
						{drawn && hasUnresolved && (
							<label className="failover-enable">
								<input
									type="checkbox"
									checked={showUnresolved}
									onChange={(event) => setShowUnresolved(event.target.checked)}
								/>
								Show unresolved
							</label>
						)}
						{drawn && (
							<>
								<button
									type="button"
									className="icon-button"
									aria-label="Zoom out"
									title="Zoom out"
									onClick={() => zoom(1 / ZOOM_STEP)}
								>
									<Icon name="minus" />
								</button>
								<button
									type="button"
									className="icon-button"
									aria-label="Zoom in"
									title="Zoom in"
									onClick={() => zoom(ZOOM_STEP)}
								>
									<Icon name="plus" />
								</button>
								<button
									type="button"
									className="icon-button"
									aria-label="Fit graph to view"
									title="Fit graph to view"
									onClick={() => {
										const stage = stageRef.current;
										if (!stage) return;
										stage.auto = true;
										fit(stage);
									}}
								>
									<Icon name="fit" />
								</button>
							</>
						)}
						{fullScreenToggle}
					</div>
				)}
			</div>
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{drawn ? (
				<>
					<p className="card-note">
						Notes are stars and links are the lines between them. Select a note
						to open it, drag to pan or move a note, and scroll to zoom.
					</p>
					{graph.truncated && (
						<p className="card-note" role="status">
							{notes < graph.noteCount
								? `Showing the ${notes.toLocaleString("en-US")} most-linked of ${count(graph.noteCount, "note")}.`
								: "Showing only the most-linked unresolved links."}
						</p>
					)}
					{/* A group, not an image: the notes inside are links. */}
					{/* biome-ignore lint/a11y/useSemanticElements: an SVG cannot be a fieldset */}
					<svg
						ref={svgRef}
						className="synapse-graph-canvas"
						role="group"
						aria-label={`Graph of ${count(notes, "note")} and ${count(shown.links.length, "link")}`}
						data-active={activeIndex >= 0 ? "" : undefined}
						onPointerDown={pointerDown}
						onPointerMove={pointerMove}
						onPointerUp={pointerUp}
						onPointerCancel={pointerUp}
						// A link would otherwise start a native drag and cancel the pointer.
						onDragStart={(event) => event.preventDefault()}
						onPointerOver={(event) =>
							setHovered(shown.nodes[indexAt(event.target)]?.title ?? null)
						}
						onPointerLeave={() => setHovered(null)}
						onFocus={(event) =>
							setFocused(shown.nodes[indexAt(event.target)]?.title ?? null)
						}
						onBlur={() => setFocused(null)}
						onClickCapture={(event) => {
							if (!dragged.current) return;
							dragged.current = false;
							event.preventDefault();
							event.stopPropagation();
						}}
						onClick={(event) => {
							const node = shown.nodes[indexAt(event.target)];
							if (!node) return;
							event.preventDefault();
							activate(node);
						}}
						onKeyDown={(event) => {
							// Links open on Enter by themselves; the buttons drawn for
							// unresolved links need it spelled out.
							if (event.key !== "Enter" && event.key !== " ") return;
							const node = shown.nodes[indexAt(event.target)];
							if (!node || node.exists) return;
							event.preventDefault();
							activate(node);
						}}
					>
						<defs>
							{[STAR_GRADIENT, CATEGORY_GRADIENT].map((id) => (
								<radialGradient key={id} id={id}>
									<stop offset="0" className="hot" />
									<stop offset="0.09" className="hot" />
									<stop offset="0.2" className="tint" />
									<stop offset="0.36" className="tint" stopOpacity="0.38" />
									<stop offset="0.64" className="tint" stopOpacity="0.1" />
									<stop offset="1" className="tint" stopOpacity="0" />
								</radialGradient>
							))}
							<pattern
								id="synapse-graph-sky"
								data-sky=""
								width={SKY_TILE}
								height={SKY_TILE}
								patternUnits="userSpaceOnUse"
							>
								{SKY_STARS.map((star) => (
									<circle
										key={`${star.x} ${star.y}`}
										cx={star.x}
										cy={star.y}
										r={star.radius}
										opacity={star.opacity}
									/>
								))}
							</pattern>
						</defs>
						{/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decoration; nothing in it takes focus or the pointer */}
						<g className="synapse-graph-sky" aria-hidden="true">
							<rect width="100%" height="100%" fill="url(#synapse-graph-sky)" />
							<g data-sky="">
								{TWINKLERS.map((star, index) => (
									<circle
										key={`${star.x} ${star.y}`}
										cx={star.x}
										cy={star.y}
										r={star.radius + 0.4}
										style={{ animationDelay: `${-index * 0.7}s` }}
									/>
								))}
							</g>
						</g>
						<g ref={viewportRef} className="synapse-graph-viewport">
							<g className="synapse-graph-edges">
								{shown.links.map(([source, target]) => (
									<line
										key={`${source}-${target}`}
										className={
											source === activeIndex || target === activeIndex
												? "near"
												: undefined
										}
									/>
								))}
							</g>
							{shown.nodes.map((node, index) => {
								const inherited = inheritedHere(node);
								const category = shown.categories.has(node.title.toLowerCase());
								const className = [
									"synapse-graph-node",
									!node.exists && "unresolved",
									inherited && "inherited",
									category && "category",
									shown.major.has(index) && "major",
									shown.lead.has(index) && "lead",
									near(index) && "near",
									node.title.toLowerCase() === currentKey && "current",
								]
									.filter(Boolean)
									.join(" ");
								const radius = nodeRadius(node.degree);
								const shape = (
									<>
										<title>
											{[
												node.title,
												!node.exists && "no note yet",
												inherited && "inherited from Global",
												category && "category",
												count(node.degree, "link"),
											]
												.filter(Boolean)
												.join(" · ")}
										</title>
										<circle
											className="halo"
											r={radius * HALO}
											fill={`url(#${category ? CATEGORY_GRADIENT : STAR_GRADIENT})`}
											opacity={haloOpacity(node.degree)}
										/>
										{/* Unpainted but still the target, so the halo never takes a click. */}
										<circle className="core" r={radius} />
										<text y={radius} dy="1.2em" textAnchor="middle">
											{shortLabel(node.title)}
										</text>
									</>
								);
								return node.exists ? (
									<a
										key={node.title}
										className={className}
										data-index={index}
										href={noteHash(space, node.title)}
										aria-label={node.title}
									>
										{shape}
									</a>
								) : canEdit ? (
									// biome-ignore lint/a11y/useSemanticElements: SVG has no button element
									<g
										key={node.title}
										className={className}
										data-index={index}
										role="button"
										tabIndex={0}
										aria-label={`Create note ${node.title}`}
									>
										{shape}
									</g>
								) : (
									<g key={node.title} className={className} data-index={index}>
										{shape}
									</g>
								);
							})}
						</g>
					</svg>
					<ul className="synapse-graph-legend" aria-label="Legend">
						{[
							{ className: "", label: "Note", show: true },
							{
								className: "category",
								label: "Category",
								show: shown.nodes.some((node) =>
									shown.categories.has(node.title.toLowerCase()),
								),
							},
							{
								className: "inherited",
								label: "Inherited from Global",
								show: shown.nodes.some(inheritedHere),
							},
							{
								className: "unresolved",
								label: "Unresolved link",
								show: shown.nodes.some((node) => !node.exists),
							},
						]
							.filter((item) => item.show)
							.map((item) => (
								<li key={item.label}>
									<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
										<g className={`synapse-graph-node ${item.className}`}>
											<circle
												className="halo"
												cx="8"
												cy="8"
												r="8"
												fill={`url(#${item.className === "category" ? CATEGORY_GRADIENT : STAR_GRADIENT})`}
											/>
											<circle className="core" cx="8" cy="8" r="4" />
										</g>
									</svg>
									{item.label}
								</li>
							))}
					</ul>
				</>
			) : (
				<p className="empty-state">
					Nothing to draw yet. Notes appear here as stars, joined by their
					links.
				</p>
			)}
		</div>
	);
}
