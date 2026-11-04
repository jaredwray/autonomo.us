import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * scrypt at OWASP's N=2^14, r=8, p=5 profile: 16 MiB per hash, which fits
 * the Workers memory limit. Parameters travel with each hash so they can be
 * raised later without invalidating existing passwords.
 */
const COST = { N: 16_384, r: 8, p: 5 };
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(
	password: string,
	salt: Buffer,
	cost: typeof COST,
	length: number,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(
			password.normalize("NFKC"),
			salt,
			length,
			{ ...cost, maxmem: MAX_MEMORY },
			(error, key) => (error ? reject(error) : resolve(key)),
		);
	});
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await derive(password, salt, COST, KEY_LENGTH);
	return [
		"scrypt",
		COST.N,
		COST.r,
		COST.p,
		salt.toString("base64url"),
		key.toString("base64url"),
	].join("$");
}

export async function verifyPassword(
	password: string,
	stored: string,
): Promise<boolean> {
	const [scheme, N, r, p, salt, expected] = stored.split("$");
	if (scheme !== "scrypt" || !salt || !expected) return false;
	const cost = { N: Number(N), r: Number(r), p: Number(p) };
	if (!Object.values(cost).every((value) => Number.isSafeInteger(value)))
		return false;
	const want = Buffer.from(expected, "base64url");
	const key = await derive(
		password,
		Buffer.from(salt, "base64url"),
		cost,
		want.length,
	);
	return key.length === want.length && timingSafeEqual(key, want);
}

let decoy: Promise<string> | undefined;
/** Spend the same work for unknown accounts so timing does not reveal them. */
export async function verifyDecoy(password: string) {
	decoy ??= hashPassword(randomBytes(16).toString("hex"));
	await verifyPassword(password, await decoy);
	return false;
}
