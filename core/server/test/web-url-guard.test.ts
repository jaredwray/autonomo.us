import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/service-error.js";
import {
	checkTargetUrl,
	isBlockedAddress,
	type Resolver,
	resolvePublicAddress,
	TargetNotFoundError,
} from "../src/web/url-guard.js";

describe("checkTargetUrl", () => {
	it("returns a normalized URL without its fragment", () => {
		const url = checkTargetUrl("  https://Example.COM/a/../b?q=1#section ");
		expect(url.href).toBe("https://example.com/b?q=1");
	});

	it.each([
		["", "Enter an http or https URL."],
		["not a url", "That is not a valid URL."],
		["ftp://example.com/file", "Only http and https URLs can be fetched."],
		["file:///etc/passwd", "Only http and https URLs can be fetched."],
		["javascript:alert(1)", "Only http and https URLs can be fetched."],
		["https://user:pass@example.com/", "user name or password"],
		["https://user@example.com/", "user name or password"],
		["https://example.com:22/", "standard web ports"],
		["http://example.com:27017/", "standard web ports"],
	])("refuses %s", (raw, message) => {
		expect(() => checkTargetUrl(raw)).toThrow(message);
	});

	it.each([
		"https://example.com:8080/",
		"https://example.com:8443/",
		"http://example.com:80/",
		"https://example.com:443/",
		"https://sub.example.co.uk/path",
		"https://93.184.215.14/",
		"https://[2606:4700::6810:84e5]/",
	])("allows %s", (raw) => {
		expect(() => checkTargetUrl(raw)).not.toThrow();
	});

	it("refuses URLs past the length limit", () => {
		expect(() =>
			checkTargetUrl(`https://example.com/${"a".repeat(3000)}`),
		).toThrow("at most 2048");
	});

	it.each([
		"http://localhost/",
		"http://localhost:8080/",
		"http://LOCALHOST./",
		"http://app.localhost/",
		"http://printer.local/",
		"http://db.internal/",
		"http://router.home.arpa/",
		"http://box.lan/",
		"http://mongo:27017/",
		"http://mongo/",
		"http://intranet/",
	])("refuses the private host name %s", (raw) => {
		expect(() => checkTargetUrl(raw)).toThrow(ServiceError);
	});

	it.each([
		"http://127.0.0.1/",
		"http://127.1/",
		"http://2130706433/",
		"http://0x7f000001/",
		"http://0177.0.0.1/",
		"http://0x7f.0.0.1/",
		"http://0/",
		"http://10.0.0.5/",
		"http://172.16.4.4/",
		"http://192.168.1.1/",
		"http://169.254.169.254/latest/meta-data/",
		"http://100.64.0.1/",
		"http://[::1]/",
		"http://[::]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:7f00:1]/",
		"http://[::ffff:169.254.169.254]/",
		"http://[64:ff9b::10.0.0.1]/",
		"http://[2002:7f00:1::]/",
		"http://[fd00::1]/",
		"http://[fe80::1]/",
		"http://[ff02::1]/",
	])("refuses the private address %s", (raw) => {
		expect(() => checkTargetUrl(raw)).toThrow(
			"private or reserved and cannot be fetched",
		);
	});
});

describe("isBlockedAddress", () => {
	it.each([
		"0.0.0.0",
		"10.1.2.3",
		"100.127.255.255",
		"127.0.0.1",
		"169.254.0.1",
		"172.31.255.255",
		"192.0.0.8",
		"192.0.2.1",
		"192.168.0.1",
		"198.18.0.1",
		"198.19.255.255",
		"224.0.0.1",
		"239.255.255.250",
		"240.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"::ffff:10.0.0.1",
		"::10.0.0.1",
		"::ffff:0:10.0.0.1",
		"64:ff9b::a00:1",
		"64:ff9b:1::1",
		"2002:a00:1::1",
		"2001:db8::1",
		"2001::1",
		"fc00::1",
		"fdff:ffff::1",
		"fe80::1%eth0",
		"fec0::1",
		"ff02::1",
		"[::1]",
		"not an ip",
	])("blocks %s", (ip) => {
		expect(isBlockedAddress(ip)).toBe(true);
	});

	it.each([
		"8.8.8.8",
		"93.184.215.14",
		"100.63.255.255",
		"100.128.0.0",
		"172.32.0.1",
		"192.169.0.1",
		"2606:4700::6810:84e5",
		"::ffff:8.8.8.8",
		"64:ff9b::808:808",
		"2002:808:808::1",
		"2a00:1450:4001::200e",
	])("allows %s", (ip) => {
		expect(isBlockedAddress(ip)).toBe(false);
	});
});

describe("resolvePublicAddress", () => {
	const resolver =
		(answers: Record<string, string[]>): Resolver =>
		async (host) => {
			const found = answers[host];
			if (!found)
				throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
					code: "ENOTFOUND",
				});
			return found.map((address) => ({
				address,
				family: address.includes(":") ? 6 : 4,
			}));
		};

	it("returns the first answer when every answer is public", async () => {
		await expect(
			resolvePublicAddress(
				"example.com",
				resolver({ "example.com": ["93.184.215.14", "2606:2800::1"] }),
			),
		).resolves.toEqual({ address: "93.184.215.14", family: 4 });
	});

	it("refuses a host that resolves to a private address", async () => {
		await expect(
			resolvePublicAddress(
				"evil.example",
				resolver({ "evil.example": ["10.0.0.7"] }),
			),
		).rejects.toThrow("evil.example resolves to a private address.");
	});

	it("refuses a host when any one answer is private", async () => {
		await expect(
			resolvePublicAddress(
				"mixed.example",
				resolver({ "mixed.example": ["93.184.215.14", "::1"] }),
			),
		).rejects.toThrow("resolves to a private address");
	});

	it("reports a host that does not exist as not found", async () => {
		const error = await resolvePublicAddress(
			"missing.example",
			resolver({}),
		).catch((caught) => caught);
		expect(error).toBeInstanceOf(TargetNotFoundError);
		expect(error.statusCode).toBe(404);
	});

	it("treats an empty answer as not found", async () => {
		await expect(
			resolvePublicAddress("empty.example", async () => []),
		).rejects.toBeInstanceOf(TargetNotFoundError);
	});

	it("reports other lookup failures without calling them not found", async () => {
		const error = await resolvePublicAddress("slow.example", async () => {
			throw Object.assign(new Error("timeout"), { code: "EAI_AGAIN" });
		}).catch((caught) => caught);
		expect(error).toBeInstanceOf(ServiceError);
		expect(error).not.toBeInstanceOf(TargetNotFoundError);
		expect(error.statusCode).toBe(502);
	});

	it("checks IP literals without resolving them", async () => {
		const never: Resolver = async () => {
			throw new Error("should not resolve");
		};
		await expect(resolvePublicAddress("8.8.8.8", never)).resolves.toEqual({
			address: "8.8.8.8",
			family: 4,
		});
		await expect(
			resolvePublicAddress("[2606:4700::1]", never),
		).resolves.toEqual({ address: "2606:4700::1", family: 6 });
		await expect(resolvePublicAddress("127.0.0.1", never)).rejects.toThrow(
			"private or reserved",
		);
	});
});
