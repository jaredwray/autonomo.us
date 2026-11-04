import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
};

/** Vite writes content-hashed bundles here, so browsers may cache them forever. */
const IMMUTABLE_PREFIX = "/assets/";

type DashboardFile = {
	path: string;
	pathname: string;
	size: number;
	mtimeMs: number;
};

function isApiPath(pathname: string): boolean {
	return pathname === "/v1" || pathname.startsWith("/v1/");
}

function acceptsHtml(request: FastifyRequest): boolean {
	const accept = request.headers.accept;
	return !accept || /(^|,)\s*(text\/html|\*\/\*)\s*(;|,|$)/i.test(accept);
}

/**
 * Maps a request path to a regular file below `root`, or undefined. Dot
 * segments (`..`, dotfiles) and anything that resolves outside `root` are
 * rejected; everything else is answered by the stat.
 */
async function resolveFile(
	root: string,
	url: string,
): Promise<DashboardFile | undefined> {
	let pathname: string;
	try {
		pathname = decodeURIComponent(url.split("?")[0]);
	} catch {
		return undefined;
	}
	if (
		pathname.includes("\0") ||
		pathname.split("/").some((segment) => segment.startsWith("."))
	)
		return undefined;
	const path = resolve(root, `.${pathname}`);
	if (path !== root && !path.startsWith(root + sep)) return undefined;
	try {
		const info = await stat(path);
		if (!info.isFile()) return undefined;
		return { path, pathname, size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return undefined;
	}
}

function sendFile(
	request: FastifyRequest,
	reply: FastifyReply,
	file: DashboardFile,
	immutable: boolean,
) {
	const etag = `W/"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`;
	reply.header("etag", etag);
	reply.header(
		"cache-control",
		immutable ? "public, max-age=31536000, immutable" : "no-cache",
	);
	if (request.headers["if-none-match"] === etag) return reply.code(304).send();
	reply.header(
		"content-type",
		CONTENT_TYPES[extname(file.path).toLowerCase()] ??
			"application/octet-stream",
	);
	reply.header("content-length", file.size);
	if (request.method === "HEAD") return reply.send();
	return reply.send(createReadStream(file.path));
}

/**
 * Serves the built dashboard from the same Fastify instance as the API, so one
 * process (or container) runs the whole product.
 *
 * It installs as the not-found handler rather than a wildcard route: API routes
 * keep precedence, unknown `/v1` paths still answer JSON and still pass through
 * authentication, and the not-found path is the only place a static file can
 * come from. Files are served as they are on disk; any other GET that accepts
 * HTML receives `index.html` for the dashboard's client-side routes.
 */
export function registerDashboard(server: FastifyInstance, directory: string) {
	const root = resolve(directory);
	server.setNotFoundHandler(async (request, reply) => {
		const pathname = request.url.split("?")[0];
		if (
			(request.method === "GET" || request.method === "HEAD") &&
			!isApiPath(pathname)
		) {
			const file = await resolveFile(root, request.url);
			if (file)
				return sendFile(
					request,
					reply,
					file,
					file.pathname.startsWith(IMMUTABLE_PREFIX),
				);
			if (acceptsHtml(request)) {
				const index = await resolveFile(root, "/index.html");
				if (index) return sendFile(request, reply, index, false);
			}
		}
		return reply.code(404).send({
			message: `Route ${request.method}:${request.url} not found`,
			error: "Not Found",
			statusCode: 404,
		});
	});
}
