import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	signature,
	type WebhookTransport,
} from "../agent-webhooks/delivery.js";
import { RpcError } from "../mcp/server.js";
import {
	checkTargetUrl,
	type Resolver,
	resolvePublicAddress,
	systemResolver,
} from "../web/url-guard.js";

export function callbackError(reason: string) {
	return new RpcError(-32015, "Callback endpoint could not be verified.", {
		reason,
	});
}
export function callbackUrl(raw: unknown): string {
	try {
		if (typeof raw !== "string" || raw.length > 2048) throw new Error();
		const url = checkTargetUrl(raw);
		if (url.protocol !== "https:" || new URL(raw).hash) throw new Error();
		return url.href;
	} catch {
		throw callbackError("invalid_url");
	}
}
export function validSecret(value: unknown): value is string {
	if (typeof value !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value))
		return false;
	const text = value.slice(6);
	const bytes = Buffer.from(text, "base64");
	return (
		bytes.length >= 24 &&
		bytes.length <= 64 &&
		bytes.toString("base64") === text
	);
}

/** All callback traffic uses this path: bounded time, fresh DNS, pinned TLS, no redirect. */
export class Callback {
	constructor(
		private readonly transport: WebhookTransport,
		private readonly resolver: Resolver = systemResolver,
	) {
		if (!transport.pinsAddress)
			throw new Error("MCP Events requires an address-pinning transport");
	}
	async post(
		subscription: {
			id: string;
			url: string;
			secret: string;
			previousSecret?: string;
			rotateUntil?: number;
		},
		id: string,
		body: string,
		now: number,
		verification = false,
		beforeSend?: () => Promise<boolean>,
	) {
		if (Buffer.byteLength(body) > 262144)
			throw new Error("MCP event exceeds payload limit");
		const signal = AbortSignal.timeout(10_000);
		// DNS resolution must also be bounded. Never expose resolver/transport errors or URLs.
		const aborted = new Promise<never>((_, reject) => {
			signal.addEventListener("abort", () => reject(callbackError("timeout")), {
				once: true,
			});
		});
		const operation = async () => {
			const url = new URL(callbackUrl(subscription.url));
			const address = await resolvePublicAddress(url.hostname, async (host) => {
				const answers = await this.resolver(host);
				for (const answer of answers) publicV6(answer.address, answer.family);
				return answers;
			});
			publicV6(address.address, address.family);
			signal.throwIfAborted();
			if (beforeSend && !(await beforeSend()))
				return { status: 0, retryAfter: null };
			signal.throwIfAborted();
			const timestamp = String(Math.floor(now / 1000));
			const signatures = [signature(subscription.secret, id, timestamp, body)];
			if (subscription.previousSecret && (subscription.rotateUntil ?? 0) > now)
				signatures.push(
					signature(subscription.previousSecret, id, timestamp, body),
				);
			return this.transport({
				url,
				address,
				signal,
				body,
				responseLimit: verification ? 4096 : undefined,
				headers: {
					"content-type": "application/json",
					"webhook-id": id,
					"webhook-timestamp": timestamp,
					"webhook-signature": signatures.join(" "),
					"X-MCP-Subscription-Id": subscription.id,
				},
			});
		};
		try {
			return await Promise.race([operation(), aborted]);
		} catch {
			throw callbackError(signal.aborted ? "timeout" : "unreachable");
		}
	}
	async verify(
		subscription: { id: string; url: string; secret: string },
		now: number,
	) {
		const challenge = randomBytes(32).toString("hex");
		const response = await this.post(
			subscription,
			`msg_verification_${randomBytes(16).toString("hex")}`,
			JSON.stringify({ type: "verification", challenge }),
			now,
			true,
		);
		let echoed: unknown;
		try {
			echoed = JSON.parse(response.body ?? "").challenge;
		} catch {
			/* refuse */
		}
		if (
			response.status < 200 ||
			response.status >= 300 ||
			typeof echoed !== "string" ||
			Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) ||
			!timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))
		)
			throw callbackError("challenge_failed");
	}
}

/** Permit only ordinary global IPv6 unicast; refuse transition/special-purpose ranges. */
function publicV6(address: string, family: number) {
	if (family !== 6) return;
	const parts = address.toLowerCase().split(":");
	const first = Number.parseInt(parts[0], 16);
	const second = Number.parseInt(parts[1] || "0", 16);
	if (
		!(first >= 0x2000 && first <= 0x3fff) ||
		first === 0x2002 ||
		first === 0x3fff ||
		(first === 0x2001 && (second < 0x200 || second === 0xdb8))
	)
		throw callbackError("invalid_address");
}
