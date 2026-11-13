import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATEWAY_COLLECTIONS, GatewayData } from "../src/gateway-data.js";

const SOURCE = join(import.meta.dirname, "../src");

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sources(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

describe("gateway data", () => {
	it("clears every collection the server writes, except the setup marker", () => {
		const names = new Set<string>();
		for (const file of sources(SOURCE)) {
			const text = readFileSync(file, "utf8");
			// Control-plane collections are named gateway_*; the others are
			// exported *_COLLECTION constants.
			for (const match of text.matchAll(/"(gateway_[a-z_]+)"/g))
				names.add(match[1] as string);
			for (const match of text.matchAll(/_COLLECTION\s*=\s*"([a-z_]+)"/g))
				names.add(match[1] as string);
		}
		// Setup rewrites its own marker when it clears everything else.
		expect(names.delete("gateway_setup")).toBe(true);
		expect([...names].sort()).toEqual([...GATEWAY_COLLECTIONS].sort());
	});

	it("reports nothing and refuses to clear without MongoDB", async () => {
		const data = new GatewayData();
		expect(data.canClear).toBe(false);
		expect(await data.inventory()).toEqual({
			connections: 0,
			tokens: 0,
			workspaces: 0,
			notes: 0,
			usageEvents: 0,
		});
		await expect(data.clear()).rejects.toThrow();
	});
});
