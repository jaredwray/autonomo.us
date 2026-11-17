import { createHmac, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
	type AgentWakeActor,
	type AgentWakeEvent,
	type AgentWakePayload,
	type AgentWebhookHeader,
	agentWebhookUrlProblem,
} from "@autonomo.us/common";
import type { FetchLike } from "../web/types.js";
import {
	type ResolvedAddress,
	type Resolver,
	resolvePublicAddress,
	TargetNotFoundError,
} from "../web/url-guard.js";
import type { StoredDelivery } from "./repository.js";

const SECRET_PREFIX = "whsec_";
export const USER_AGENT = "autonomo.us-webhooks/1";

/** A new signing secret: `whsec_` and the base64 of 32 random bytes, as Standard Webhooks writes it. */
export function newSecret(): string {
	return `${SECRET_PREFIX}${randomBytes(32).toString("base64")}`;
}

/**
 * The `webhook-signature` header of Standard Webhooks: `v1,` and the base64
 * HMAC-SHA256 of `<id>.<timestamp>.<body>`, keyed by the bytes after `whsec_`.
 */
export function signature(
	secret: string,
	id: string,
	timestamp: string,
	body: string,
): string {
	const key = Buffer.from(secret.slice(SECRET_PREFIX.length), "base64");
	return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** A name or title as one short line, so it reads as data inside the text. */
function line(value: string, max = 80): string {
	const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
const KIND = {
	user: "person",
	agent: "agent",
	"api-token": "token",
	system: "gateway",
};
/** Who did something: a name and what kind of actor it is. */
const who = (actor: AgentWakeActor) =>
	`${line(actor.name)} (${KIND[actor.kind]})`;
const range = (seqs: number[]) => {
	const low = Math.min(...seqs);
	const high = Math.max(...seqs);
	return low === high ? `message ${low}` : `messages ${low}–${high}`;
};
const names = (list: string[]) =>
	list.length <= 2
		? list.join(" and ")
		: `${list.slice(0, 2).join(", ")}, and ${list.length - 2} more`;
const count = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;
const SPACE = {
	shared: "the shared Synapse",
	global: "the global Synapse",
	agent: "your own Synapse space",
};
const NOTE_VERB = {
	"synapse.note_created": "created",
	"synapse.note_updated": "changed",
	"synapse.note_deleted": "deleted",
};
const MODELS_CHANGE = {
	models: "its models or connections",
	routing: "its routing",
	failover: "its failover",
};

/** What to do about the events of one kind, said once below the list. */
const NEXT = {
	channels:
		"Read each channel above with channels_read: it starts at your read mark, so it shows everything you have not handled. Mark what you handled with channels_mark_read.",
	membership:
		"Call channels_list to see the channels you are in now and what is unread in each.",
	proposals:
		"Call synapse_proposals to see each decision and its reason, and follow up on rejected ones.",
	notes:
		'Read a note above with synapse_read (space "shared" for the shared and global Synapse) before relying on what you remember of it.',
	agent:
		"Your grants decide which tools you have: list your tools again before you rely on one.",
	models: "Call models_list to see the models you can use now.",
} as const;

/**
 * The payload's `text`: what happened and what to do next, in words. A
 * Claude Code routine passes only this field to its run. It holds names and
 * places, never message text or note bodies.
 */
export function wakeText(
	agentName: string,
	events: readonly AgentWakeEvent[],
	omitted: number,
): string {
	const lines: string[] = [];
	const messages = new Map<
		string,
		{ channel: string; seqs: number[]; authors: string[] }
	>();
	const next = new Set<keyof typeof NEXT>();
	for (const event of events) {
		switch (event.type) {
			case "channel.mention":
				next.add("channels");
				lines.push(
					`- ${who(event.author)} mentioned you in #${event.channel}, message ${event.seq}${event.threadId ? " in a thread" : ""}.`,
				);
				break;
			case "channel.reply":
				next.add("channels");
				lines.push(
					`- ${who(event.author)} replied in a thread you started in #${event.channel}, message ${event.seq}.`,
				);
				break;
			case "channel.message": {
				next.add("channels");
				const group = messages.get(event.channelId) ?? {
					channel: event.channel,
					seqs: [],
					authors: [],
				};
				group.seqs.push(event.seq);
				const author = line(event.author.name, 40);
				if (!group.authors.includes(author)) group.authors.push(author);
				messages.set(event.channelId, group);
				break;
			}
			case "channel.message_edited":
				next.add("channels");
				lines.push(
					`- ${who(event.by)} edited message ${event.seq} in #${event.channel}${event.mentioned ? ", which mentions you" : ""}.`,
				);
				break;
			case "channel.message_deleted":
				next.add("channels");
				lines.push(
					`- ${who(event.by)} deleted message ${event.seq} in #${event.channel}${event.own ? ", which you wrote" : ""}.`,
				);
				break;
			case "channel.joined":
				next.add("membership");
				lines.push(
					`- ${who(event.by)} added you to #${event.channel} with ${event.access} access.`,
				);
				break;
			case "channel.access_changed":
				next.add("membership");
				lines.push(
					`- ${who(event.by)} changed your access to #${event.channel} from ${event.previousAccess} to ${event.access}.`,
				);
				break;
			case "channel.left":
				next.add("membership");
				lines.push(`- ${who(event.by)} removed you from #${event.channel}.`);
				break;
			case "channel.updated": {
				const changes = event.changes.map((change) =>
					change === "name" && event.previousName
						? `renamed it from #${event.previousName}`
						: `changed its ${change}`,
				);
				lines.push(
					`- ${who(event.by)} updated #${event.channel}: ${changes.join(", ")}.`,
				);
				break;
			}
			case "channel.archived":
			case "channel.unarchived":
				next.add("membership");
				lines.push(
					`- ${who(event.by)} ${event.type === "channel.archived" ? "archived" : "unarchived"} #${event.channel}.`,
				);
				break;
			case "proposal.decided":
				next.add("proposals");
				lines.push(
					`- ${line(event.decidedBy)} ${event.status} your proposal to ${event.action} "${line(event.title)}" in the shared Synapse.`,
				);
				break;
			case "synapse.note_created":
			case "synapse.note_updated":
			case "synapse.note_deleted":
				if (event.type !== "synapse.note_deleted") next.add("notes");
				lines.push(
					event.previousTitle
						? `- ${who(event.by)} renamed "${line(event.previousTitle)}" to "${line(event.title)}" in ${SPACE[event.space]}.`
						: `- ${who(event.by)} ${NOTE_VERB[event.type]} "${line(event.title)}" in ${SPACE[event.space]}.`,
				);
				break;
			case "synapse.imported":
				next.add("notes");
				lines.push(
					`- ${who(event.by)} imported notes into ${SPACE[event.space]}: ${event.created} created, ${event.updated} changed.`,
				);
				break;
			case "agent.updated": {
				const did = [
					event.previousName &&
						`renamed you from "${line(event.previousName)}"`,
					event.changes.includes("description") && "changed your description",
				].filter(Boolean);
				lines.push(
					`- ${who(event.by)} ${did.join(" and ") || "changed your settings"}.`,
				);
				break;
			}
			case "agent.permissions_changed": {
				next.add("agent");
				const parts = [
					event.added.length &&
						`added ${event.added.map((id) => line(id)).join(", ")}`,
					event.removed.length &&
						`removed ${event.removed.map((id) => line(id)).join(", ")}`,
				].filter(Boolean);
				lines.push(
					`- ${who(event.by)} changed your grants: ${parts.join("; ")}.`,
				);
				break;
			}
			case "agent.token_rolled":
				lines.push(
					`- ${who(event.by)} rolled your agent token. The token it replaced works until ${event.previousValidUntil}.`,
				);
				break;
			case "agent.app_connected":
				lines.push(
					`- The app ${line(event.app)} signed in to you${event.approvedBy ? `, approved by ${line(event.approvedBy)}` : ""}.`,
				);
				break;
			case "agent.app_disconnected":
				lines.push(
					`- The app ${line(event.app)} was disconnected from you${event.by ? ` by ${line(event.by)}` : ""}. ${line(event.reason, 200)}`,
				);
				break;
			case "workspace.updated":
				lines.push(
					`- ${who(event.by)} ${event.previousName ? `renamed the workspace from "${line(event.previousName)}" to "${line(event.name)}"` : `changed the description of the workspace "${line(event.name)}"`}.`,
				);
				break;
			case "workspace.member_added":
				lines.push(
					`- ${who(event.by)} added ${line(event.member.name)} to the workspace as ${line(event.role)}.`,
				);
				break;
			case "workspace.member_changed":
				lines.push(
					`- ${who(event.by)} changed ${line(event.member.name)} from ${line(event.previousRole)} to ${line(event.role)} in the workspace.`,
				);
				break;
			case "workspace.member_removed":
				lines.push(
					`- ${who(event.by)} removed ${line(event.member.name)} from the workspace.`,
				);
				break;
			case "models.changed":
				next.add("models");
				lines.push(
					`- ${who(event.by)} changed the workspace's models: ${MODELS_CHANGE[event.change]}.`,
				);
				break;
			case "web.changed":
				lines.push(
					`- ${who(event.by)} changed the workspace's web access: its ${event.change}.`,
				);
				break;
			case "webhook.test":
				lines.push(
					`- ${line(event.requestedBy)} sent a test from the autonomo.us dashboard. Nothing happened, so there is nothing to do.`,
				);
				break;
		}
	}
	for (const group of messages.values())
		lines.push(
			`- ${count(group.seqs.length, "new message")} in #${group.channel} (${range(group.seqs)}) from ${names(group.authors)}.`,
		);
	if (omitted)
		lines.push(
			`- ${omitted} more ${omitted === 1 ? "update" : "updates"} did not fit here; your channels, proposals, and Synapse show them.`,
		);
	const total = events.length + omitted;
	// In the order of `NEXT`, whatever order the events came in.
	const advice = (Object.keys(NEXT) as Array<keyof typeof NEXT>)
		.filter((key) => next.has(key))
		.map((key) => NEXT[key]);
	return [
		`autonomo.us woke ${line(agentName)} with ${count(total, "update")}:`,
		...lines,
		...(advice.length ? ["", ...advice] : []),
	].join("\n");
}

/** The JSON body of a delivery. The same delivery always gives the same body. */
export function wakeBody(
	workspaceId: string,
	agent: { id: string; name: string },
	delivery: Pick<StoredDelivery, "createdAt" | "events" | "omitted">,
): string {
	const payload: AgentWakePayload = {
		type: "agent.wake",
		timestamp: delivery.createdAt,
		data: {
			workspaceId,
			agent,
			events: delivery.events,
			omitted: delivery.omitted,
		},
		text: wakeText(agent.name, delivery.events, delivery.omitted),
	};
	return JSON.stringify(payload);
}

export type WebhookRequest = {
	url: URL;
	/** The checked address to connect to; null when the transport cannot pin one. */
	address: ResolvedAddress | null;
	headers: Record<string, string>;
	body: string;
	signal: AbortSignal;
	/** Opt in to a bounded response body for MCP callback verification. */
	responseLimit?: number;
};
export type WebhookResponse = {
	status: number;
	retryAfter: string | null;
	body?: string;
};
/**
 * Sends one POST without following redirects and without reading the body.
 * `pinsAddress`: the transport connects to the address it is given, so the
 * name is checked against private addresses first.
 */
export type WebhookTransport = ((
	request: WebhookRequest,
) => Promise<WebhookResponse>) & { readonly pinsAddress: boolean };

/**
 * Node's HTTPS client, connecting to the checked address whatever DNS says by
 * the time the socket opens. TLS still verifies the certificate by host name.
 */
export function nodeWebhookTransport(): WebhookTransport {
	const send = (request: WebhookRequest) =>
		new Promise<WebhookResponse>((resolve, reject) => {
			const { address } = request;
			const lookup: LookupFunction | undefined = address
				? (_hostname, options, callback) => {
						if ((options as { all?: boolean }).all)
							(callback as (error: null, addresses: ResolvedAddress[]) => void)(
								null,
								[address],
							);
						else callback(null, address.address, address.family);
					}
				: undefined;
			const client = httpsRequest(
				request.url,
				{
					method: "POST",
					headers: {
						...request.headers,
						"content-length": String(Buffer.byteLength(request.body)),
					},
					agent: false,
					signal: request.signal,
					servername: request.url.hostname,
					...(lookup ? { lookup } : {}),
				},
				(response) => {
					const retryAfter = response.headers["retry-after"];
					const result = {
						status: response.statusCode ?? 0,
						retryAfter: typeof retryAfter === "string" ? retryAfter : null,
					};
					if (!request.responseLimit) {
						resolve(result);
						response.destroy();
						return;
					}
					const chunks: Buffer[] = [];
					let size = 0;
					response.on("error", reject);
					response.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > (request.responseLimit ?? 0)) {
							response.destroy(new Error("Webhook response too large"));
							return;
						}
						chunks.push(chunk);
					});
					response.on("end", () =>
						resolve({
							...result,
							body: Buffer.concat(chunks).toString("utf8"),
						}),
					);
				},
			);
			client.on("error", reject);
			client.end(request.body);
		});
	return Object.assign(send, { pinsAddress: true as const });
}

/**
 * The Worker's fetch. It cannot choose the address it connects to, so the
 * name is not resolved first; Cloudflare's network cannot reach the
 * deployment's private network.
 */
export function fetchWebhookTransport(fetchImpl?: FetchLike): WebhookTransport {
	const send = async (request: WebhookRequest): Promise<WebhookResponse> => {
		const response = await (fetchImpl ?? fetch)(request.url, {
			method: "POST",
			headers: request.headers,
			body: request.body,
			redirect: "manual",
			signal: request.signal,
		});
		await response.body?.cancel().catch(() => {});
		return {
			status: response.status,
			retryAfter: response.headers.get("retry-after"),
		};
	};
	return Object.assign(send, { pinsAddress: false as const });
}

/** How one POST ended, before the state machine decides what follows. */
export type PostResult =
	| { kind: "ok"; status: number }
	| { kind: "gone"; status: number }
	| { kind: "throttled"; status: number; retryAfterMs: number | null }
	| { kind: "failed"; status: number | null; error: string }
	/** `beforeSend` called it off: nothing was sent. */
	| { kind: "cancelled"; status: null };

class Aborted extends Error {}

/**
 * Settles with `work`, or rejects with `Aborted` once `signal` aborts. A DNS
 * lookup cannot be cancelled, so the POST stops waiting for it instead.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(new Aborted());
		if (signal.aborted) return stop();
		signal.addEventListener("abort", stop, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", stop);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", stop);
				reject(error);
			},
		);
	});
}

/** Seconds or an HTTP date, as milliseconds from `now`. */
export function retryAfterMs(value: string | null, now: number): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const at = Date.parse(trimmed);
	return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export type PostTarget = {
	url: string;
	secret: string;
	authKey: string | null;
	headers: AgentWebhookHeader[];
};

/**
 * Signs and sends one delivery. The custom headers and the auth key go first,
 * so the headers the gateway sets always win; the receiver's body is never
 * read, and redirects are not followed.
 */
export async function post(
	target: PostTarget,
	deliveryId: string,
	body: string,
	options: {
		transport: WebhookTransport;
		resolver?: Resolver;
		timeoutMs: number;
		now: () => number;
		/** Aborts the POST early, for a shutdown. */
		signal?: AbortSignal;
		/**
		 * Called after the lookup, just before the POST goes out, for the
		 * webhook as it stands now: null calls the POST off, so a pause,
		 * deletion, or new URL that came meanwhile is honored, and a new
		 * secret or key is used.
		 */
		beforeSend?: () => Promise<PostTarget | null>;
	},
): Promise<PostResult> {
	if (agentWebhookUrlProblem(target.url))
		return { kind: "failed", status: null, error: "blocked" };
	const url = new URL(target.url);
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
		: AbortSignal.timeout(options.timeoutMs);
	let address: ResolvedAddress | null = null;
	if (options.transport.pinsAddress && options.resolver) {
		try {
			address = await untilAborted(
				resolvePublicAddress(url.hostname, options.resolver),
				signal,
			);
		} catch (error) {
			return {
				kind: "failed",
				status: null,
				error:
					error instanceof Aborted
						? "timeout"
						: error instanceof TargetNotFoundError
							? "network"
							: "blocked",
			};
		}
	}
	let to = target;
	if (options.beforeSend) {
		let current: PostTarget | null;
		try {
			current = await untilAborted(options.beforeSend(), signal);
		} catch (error) {
			if (error instanceof Aborted)
				return { kind: "failed", status: null, error: "timeout" };
			throw error;
		}
		// A different URL was not the one checked above.
		if (!current || current.url !== target.url)
			return { kind: "cancelled", status: null };
		to = current;
	}
	const headers: Record<string, string> = {};
	for (const header of to.headers)
		headers[header.name.toLowerCase()] = header.value;
	if (to.authKey) headers.authorization = `Bearer ${to.authKey}`;
	const timestamp = String(Math.floor(options.now() / 1000));
	Object.assign(headers, {
		"content-type": "application/json",
		"user-agent": USER_AGENT,
		"webhook-id": deliveryId,
		"webhook-timestamp": timestamp,
		"webhook-signature": signature(to.secret, deliveryId, timestamp, body),
	});
	let response: WebhookResponse;
	try {
		response = await options.transport({
			url,
			address,
			headers,
			body,
			signal,
		});
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		return {
			kind: "failed",
			status: null,
			error:
				name === "TimeoutError" || name === "AbortError"
					? "timeout"
					: "network",
		};
	}
	const { status } = response;
	if (status >= 200 && status < 300) return { kind: "ok", status };
	// Standard Webhooks: 410 Gone asks the sender to stop.
	if (status === 410) return { kind: "gone", status };
	if (status === 429)
		return {
			kind: "throttled",
			status,
			retryAfterMs: retryAfterMs(response.retryAfter, options.now()),
		};
	if (status >= 300 && status < 400)
		return { kind: "failed", status, error: "redirect" };
	return { kind: "failed", status, error: `http_${status}` };
}
