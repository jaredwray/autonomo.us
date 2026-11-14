import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WEB_LIMITS } from "@autonomo.us/common";
import { ServiceError } from "../service-error.js";

/**
 * The URL rules every fetch passes before anything is sent, whether to the
 * site itself or to a provider. On Node the gateway sits next to MongoDB and
 * whatever else shares its network, so nothing an agent names may reach it.
 */

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
/** Names that only mean something inside a private network. */
const PRIVATE_SUFFIXES = [
	".localhost",
	".local",
	".localdomain",
	".internal",
	".lan",
	".home.arpa",
];

/** The host a DNS name or literal resolves to. */
export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

/** The system resolver, every answer in the order the resolver gave them. */
export const systemResolver: Resolver = async (host) =>
	(await lookup(host, { all: true, order: "verbatim" })).map((answer) => ({
		address: answer.address,
		family: answer.family === 6 ? 6 : 4,
	}));

/** The host does not exist; the fetch reports `not-found`, not a block. */
export class TargetNotFoundError extends ServiceError {
	constructor(host: string) {
		super(`The host ${host} does not exist.`, 404);
	}
}

/**
 * Checks a URL an agent or person asked for and returns it normalized, with
 * its fragment removed. Throws a `ServiceError` an agent can read.
 */
export function checkTargetUrl(raw: string): URL {
	if (typeof raw !== "string" || !raw.trim())
		throw new ServiceError("Enter an http or https URL.");
	if (raw.length > WEB_LIMITS.urlLength)
		throw new ServiceError(
			`URLs are at most ${WEB_LIMITS.urlLength} characters.`,
		);
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new ServiceError("That is not a valid URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new ServiceError("Only http and https URLs can be fetched.");
	if (url.username || url.password)
		throw new ServiceError("URLs with a user name or password are refused.");
	if (!ALLOWED_PORTS.has(url.port))
		throw new ServiceError(
			"Only the standard web ports (80, 443, 8080, 8443) can be fetched.",
		);
	const host = bareHost(url.hostname);
	if (!host) throw new ServiceError("That URL has no host.");
	const literal = isIP(host);
	if (literal) {
		if (isBlockedAddress(host))
			throw new ServiceError(
				"That address is private or reserved and cannot be fetched.",
			);
	} else {
		const name = host.endsWith(".") ? host.slice(0, -1) : host;
		if (
			name === "localhost" ||
			!name.includes(".") ||
			PRIVATE_SUFFIXES.some((suffix) => name.endsWith(suffix))
		)
			throw new ServiceError(
				"That host name only exists on a private network and cannot be fetched.",
			);
	}
	url.hash = "";
	return url;
}

/**
 * Resolves a host and refuses it when any answer is private: an attacker's
 * DNS can return one public and one private address, and the connection
 * may use either. The caller connects to the address returned here.
 */
export async function resolvePublicAddress(
	host: string,
	resolver: Resolver,
): Promise<ResolvedAddress> {
	const name = bareHost(host);
	const family = isIP(name);
	if (family) {
		if (isBlockedAddress(name))
			throw new ServiceError(
				"That address is private or reserved and cannot be fetched.",
			);
		return { address: name, family: family === 6 ? 6 : 4 };
	}
	let answers: ResolvedAddress[];
	try {
		answers = await resolver(name);
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code === "ENOTFOUND" || code === "ENODATA")
			throw new TargetNotFoundError(name);
		throw new ServiceError(`Could not look up ${name}.`, 502, {
			cause: error,
		});
	}
	if (!answers.length) throw new TargetNotFoundError(name);
	if (answers.some((answer) => isBlockedAddress(answer.address)))
		throw new ServiceError(`${name} resolves to a private address.`);
	return answers[0];
}

/** A URL hostname without IPv6 brackets, lower case. */
function bareHost(hostname: string): string {
	const host = hostname.toLowerCase();
	return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Whether an IP address is loopback, private, link-local (which covers cloud
 * metadata), shared, reserved, multicast, or an IPv6 form that carries one of
 * those IPv4 addresses. Anything that is not an IP address is refused too.
 */
export function isBlockedAddress(ip: string): boolean {
	const address = bareHost(ip.trim());
	const family = isIP(address);
	if (family === 4) return blockedV4(parseV4(address));
	if (family === 6) {
		const words = parseV6(address);
		return words ? blockedV6(words) : true;
	}
	return true;
}

/** Blocked IPv4 ranges as [network, prefix length]. */
const BLOCKED_V4: Array<[number, number]> = [
	[0x00000000, 8], // "this network"
	[0x0a000000, 8], // RFC 1918
	[0x64400000, 10], // carrier-grade NAT
	[0x7f000000, 8], // loopback
	[0xa9fe0000, 16], // link-local, cloud metadata
	[0xac100000, 12], // RFC 1918
	[0xc0000000, 24], // IETF protocol assignments
	[0xc0000200, 24], // documentation
	[0xc0586300, 24], // 6to4 relay
	[0xc0a80000, 16], // RFC 1918
	[0xc6120000, 15], // benchmarking
	[0xc6336400, 24], // documentation
	[0xcb007100, 24], // documentation
	[0xe0000000, 4], // multicast
	[0xf0000000, 4], // reserved, broadcast
];

function blockedV4(value: number): boolean {
	return BLOCKED_V4.some(([network, bits]) => {
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		return (value & mask) >>> 0 === network;
	});
}

function parseV4(address: string): number {
	return (
		address
			.split(".")
			.reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0) >>> 0
	);
}

/** Eight 16-bit words, or null when the text is not one IPv6 address. */
function parseV6(address: string): number[] | null {
	let text = address;
	const zone = text.indexOf("%");
	if (zone >= 0) text = text.slice(0, zone);
	let tail: number[] = [];
	const lastColon = text.lastIndexOf(":");
	const end = text.slice(lastColon + 1);
	if (end.includes(".")) {
		if (isIP(end) !== 4) return null;
		const v4 = parseV4(end);
		tail = [v4 >>> 16, v4 & 0xffff];
		text = `${text.slice(0, lastColon + 1)}0`;
		// "::1.2.3.4" leaves "::0": the placeholder stands for both v4 words.
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const words = (part: string) =>
		part ? part.split(":").map((word) => Number.parseInt(word, 16)) : [];
	const head = words(halves[0]);
	const rest = halves.length === 2 ? words(halves[1]) : [];
	if (tail.length) {
		// Replace the placeholder 0 with the two IPv4 words.
		if (halves.length === 2) rest.pop();
		else head.pop();
	}
	const known = head.length + rest.length + tail.length;
	if (known > 8 || (halves.length === 1 && known !== 8)) return null;
	const fill = new Array(8 - known).fill(0);
	const all = [...head, ...fill, ...rest, ...tail];
	return all.every(
		(word) => Number.isInteger(word) && word >= 0 && word <= 0xffff,
	)
		? all
		: null;
}

function blockedV6(w: number[]): boolean {
	const zeros = (from: number, to: number) =>
		w.slice(from, to).every((word) => word === 0);
	const v4 = (high: number, low: number) =>
		blockedV4(((w[high] << 16) | w[low]) >>> 0);
	// Unspecified and loopback.
	if (zeros(0, 7) && (w[7] === 0 || w[7] === 1)) return true;
	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
	if (zeros(0, 5) && w[5] === 0xffff) return v4(6, 7);
	if (zeros(0, 6)) return v4(6, 7);
	// IPv4-translated (::ffff:0:a.b.c.d).
	if (zeros(0, 4) && w[4] === 0xffff && w[5] === 0) return v4(6, 7);
	// NAT64: the well-known prefix carries an IPv4 address; the local-use one is private.
	if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return v4(6, 7);
	if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return true;
	// 6to4 carries an IPv4 address in its second and third words.
	if (w[0] === 0x2002) return v4(1, 2);
	// Teredo and documentation.
	if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8)) return true;
	// Discard-only.
	if (w[0] === 0x100 && zeros(1, 4)) return true;
	// Unique local, link-local, site-local, and multicast.
	if ((w[0] & 0xfe00) === 0xfc00) return true;
	if ((w[0] & 0xffc0) === 0xfe80) return true;
	if ((w[0] & 0xffc0) === 0xfec0) return true;
	if ((w[0] & 0xff00) === 0xff00) return true;
	return false;
}
