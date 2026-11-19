import { expect, test } from "@playwright/test";
import { seedRustboy } from "../../server/scripts/fixtures/rustboy.js";
import { createServer } from "../../server/src/server.js";

test("a narrow reporting map and a desktop escalation trace use the same workspace", async ({
	page,
}) => {
	const gateway = createServer({
		config: { providers: [], corsOrigins: [] },
		logger: false,
	});
	try {
		const studio = await seedRustboy(gateway);
		const api = await gateway.listen({ host: "127.0.0.1", port: 0 });
		// Vite serves the actual dashboard. Forward its same-origin API requests to the fixture gateway.
		await page.route("**/v1/**", async (route) => {
			const url = new URL(route.request().url());
			const response = await route.fetch({
				url: api + url.pathname + url.search,
			});
			await route.fulfill({ response });
		});
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(
			`/#/w/${studio.workspaceId}/organization/positions/${studio.splice.id}`,
		);
		await page.getByLabel("Email", { exact: true }).fill(studio.email);
		await page.getByLabel("Password", { exact: true }).fill(studio.password);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Shot Editor" }),
		).toBeVisible();
		const map = page.getByRole("region", { name: "Reporting hierarchy" });
		await expect(
			map.getByRole("link", { name: /Studio Director/ }),
		).toBeVisible();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
		await page.setViewportSize({ width: 1440, height: 940 });
		const reporting = page.getByRole("tab", { name: "Reporting" });
		await reporting.focus();
		await reporting.press("ArrowRight");
		const route = page.getByRole("list", { name: "Decision route" });
		await expect(route.getByRole("link")).toHaveText([
			"Shot Editor",
			"Art Director",
			"Executive Producer",
		]);
		await expect(page.getByText(/Response window 30 min/)).toBeVisible();
		await route.getByRole("link", { name: "Art Director" }).click();
		await expect(
			page.getByRole("heading", { name: "Art Director" }),
		).toBeVisible();
		await expect(page.getByRole("tab", { name: "Reporting" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	} finally {
		gateway.server.closeAllConnections();
		await gateway.close();
	}
});
