import { DurableObject } from "cloudflare:workers";
import { containerEnvironment } from "./container-environment.js";
import {
	MAINTENANCE_PATHS,
	PUBLIC_INGRESS_HEADER,
} from "./maintenance-protocol.js";

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
		const control = container.getTcpPort(3000);
		for (let attempt = 0; attempt < 12; attempt++) {
			try {
				const response = await control.fetch(
					`http://container${MAINTENANCE_PATHS.ready}`,
					{
						headers: { authorization: `Bearer ${env.CONTAINER_CONTROL_TOKEN}` },
						signal: AbortSignal.timeout(10_000),
					},
				);
				await response.body?.cancel();
				if (response.ok) return;
			} catch {
				/* Cold starts and transient database outages are retried. */
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error("Container readiness timed out");
	}
	private async armDrain() {
		// Arm durably BEFORE forwarding a request that can start detached Node work.
		const next = Date.now() + 1000;
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
	}
	async alarm() {
		// Alarms can await long bot runs (the fetch waitUntil budget cannot).
		// A failed alarm retries through the platform; cron is an independent recovery path.
		// Request alarms only drain work already started; never scan durable queues.
		// A stopped/crashed instance is recovered by the independent cron invocation.
		if (!this.container.running) return;
		const response = await this.container
			.getTcpPort(3000)
			.fetch(`http://container${MAINTENANCE_PATHS.drain}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.env.CONTAINER_CONTROL_TOKEN}`,
				},
				signal: AbortSignal.timeout(14 * 60_000),
			});
		await response.body?.cancel();
		if (!response.ok) throw new Error("Container background drain failed");
	}
	async fetch(request: Request) {
		if (new URL(request.url).pathname.startsWith("/_internal"))
			return new Response(null, {
				status: 404,
				headers: { "cache-control": "no-store" },
			});
		await this.ready();
		const canStartWork = !["GET", "HEAD", "OPTIONS"].includes(request.method);
		if (canStartWork) await this.armDrain();
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
		// Force this marker on EVERY public request, even encoded path aliases.
		// Maintenance handlers reject its presence; only fixed internal calls omit it.
		forwarded.headers.set(PUBLIC_INGRESS_HEADER, "1");
		// Never retry an application request: the first attempt may have committed.
		const response = await this.container.getTcpPort(3000).fetch(forwarded);
		// The first alarm may have run during a slow request, before it enqueued work.
		// Preserve a committed response if this best-effort re-arm fails. Cron recovers.
		if (canStartWork) {
			try {
				await this.armDrain();
			} catch {
				console.error("gateway.container_alarm_rearm_failed");
			}
		}
		return response;
	}
	async sweep() {
		const deadline = Date.now() + 14 * 60_000;
		await this.ready();
		const response = await this.container
			.getTcpPort(3000)
			.fetch(`http://container${MAINTENANCE_PATHS.sweep}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.env.CONTAINER_CONTROL_TOKEN}`,
				},
				signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
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
