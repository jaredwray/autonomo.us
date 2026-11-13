import type { FastifyRequest } from "fastify";

const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

export type OriginOptions = {
	/** PUBLIC_URL: used as is when set. */
	publicUrl?: string;
	/** The runtime ends TLS itself and hides it from the server (Workers). */
	assumeHttps?: boolean;
};

/**
 * The address this request reached the gateway at, without a path. OAuth
 * metadata must name the address the app itself used, so it comes from the
 * request unless PUBLIC_URL fixes it. A proxy that ends TLS says so in
 * `x-forwarded-proto`; the header only changes what the caller itself is told.
 */
export function publicOrigin(
	request: FastifyRequest,
	options: OriginOptions,
): string {
	if (options.publicUrl) return options.publicUrl;
	const header = request.headers.host ?? "";
	const host = HOST.test(header) ? header.toLowerCase() : "localhost";
	const forwarded = String(request.headers["x-forwarded-proto"] ?? "")
		.split(",")[0]
		.trim()
		.toLowerCase();
	const protocol =
		forwarded === "https" || forwarded === "http"
			? forwarded
			: LOOPBACK.test(host)
				? "http"
				: options.assumeHttps
					? "https"
					: request.protocol;
	return `${protocol}://${host}`;
}
