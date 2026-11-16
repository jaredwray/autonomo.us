import { DurableObject } from "cloudflare:workers";
import { containerEnvironment } from "./container-environment.js";

interface Env extends Record<string, unknown> {
	GATEWAY: DurableObjectNamespace<GatewayContainer>;
	CONTAINER_CONTROL_TOKEN: string;
}
const INACTIVITY_MS = 45_000;
const INSTANCE = "gateway-v1";

/** Native Container API. No outbound intercepts: Node owns DNS, TCP and TLS. */
export class GatewayContainer extends DurableObject<Env> {
	private starting?: Promise<void>;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		if (ctx.container?.running) {
			void ctx.blockConcurrencyWhile(() =>
				this.container.setInactivityTimeout(INACTIVITY_MS),
			);
		}
	}
	private get container() {
		if (!this.ctx.container) throw new Error("Missing container binding");
		return this.ctx.container;
	}
	private ready() {
		this.starting ??= this.startAndWait().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}
	private async startAndWait() {
		const container = this.container;
		const env = containerEnvironment(this.env);
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify(env)),
		);
		const configuration = Array.from(new Uint8Array(digest), (value) =>
			value.toString(16).padStart(2, "0"),
		).join("");
		const info = container.running ? await container.inspect() : null;
		// Under durable_object scheduling, a deploy does not update running images.
		// Drain through Node's SIGTERM hook before replacing an old image.
		if (
			container.running &&
			(info?.image !== container.images.base ||
				info?.labels.configuration !== configuration)
		) {
			container.signal(15);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					container.monitor().catch(() => {}),
					new Promise((resolve) => {
						timer = setTimeout(resolve, 20_000);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
			if (container.running) await container.destroy();
		}
		if (!container.running)
			container.start({
				image: container.images.base,
				instance: "lite",
				enableInternet: true,
				env,
				labels: { configuration },
			});
		await container.setInactivityTimeout(INACTIVITY_MS);
		const control = container.getTcpPort(3001);
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				const response = await control.fetch("http://container/ready", {
					headers: { authorization: `Bearer ${env.CONTAINER_CONTROL_TOKEN}` },
					signal: AbortSignal.timeout(2000),
				});
				await response.body?.cancel();
				if (response.ok) return;
			} catch {
				/* Cold starts and transient database outages are retried. */
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error("Container readiness timed out");
	}
	async fetch(request: Request) {
		await this.ready();
		const url = new URL(request.url);
		url.protocol = "http:";
		url.host = "container";
		const forwarded = new Request(url, request);
		// PUBLIC_URL is authoritative for OAuth; never trust caller forwarding headers.
		for (const name of [
			"host",
			"forwarded",
			"x-forwarded-host",
			"x-forwarded-proto",
			"x-forwarded-for",
		])
			forwarded.headers.delete(name);
		// Never retry an application request: the first attempt may have committed.
		return this.container.getTcpPort(3000).fetch(forwarded);
	}
	async sweep() {
		await this.ready();
		const response = await this.container
			.getTcpPort(3001)
			.fetch("http://container/sweep", {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.env.CONTAINER_CONTROL_TOKEN}`,
				},
				signal: AbortSignal.timeout(55_000),
			});
		await response.body?.cancel();
		if (!response.ok) throw new Error("Container retry sweep failed");
	}
}
export default {
	async fetch(request: Request, env: Env) {
		try {
			return await env.GATEWAY.getByName(INSTANCE).fetch(request);
		} catch {
			console.error("gateway.container_unavailable");
			return Response.json(
				{ error: "The API is temporarily unavailable." },
				{
					status: 503,
					headers: { "cache-control": "no-store", "retry-after": "5" },
				},
			);
		}
	},
	async scheduled(_controller: ScheduledController, env: Env) {
		// Platform schedule exists independently of process timers and DO eviction.
		// Failure rejects the invocation for monitoring; the next tick retries Mongo work.
		try {
			await env.GATEWAY.getByName(INSTANCE).sweep();
		} catch {
			console.error("gateway.container_sweep_failed");
			throw new Error("Container retry sweep failed");
		}
	},
};
