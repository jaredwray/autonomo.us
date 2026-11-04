/** The part of the Workers runtime's request context that the entry uses. */
interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}

declare module "cloudflare:workers" {
	export const env: Record<string, string | undefined>;
}

declare module "cloudflare:node" {
	export function httpServerHandler(options: { port: number }): {
		fetch(
			request: Request,
			env: unknown,
			ctx: ExecutionContext,
		): Promise<Response>;
	};
}
