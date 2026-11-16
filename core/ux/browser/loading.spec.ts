import { expect, test } from "@playwright/test";

const models = {
	models: [
		{ id: "local/synthetic-model", provider: "local", name: "synthetic-model" },
	],
	providers: [
		{ name: "local", kind: "openai-compatible", models: ["synthetic-model"] },
	],
};
const providers = { connections: [], providers: [], persistence: "memory" };

async function holdModels(page: import("@playwright/test").Page) {
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const unexpected: string[] = [];
	await page.route("**/v1/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/models") && !path.endsWith("/catalog")) {
			await pending;
			await route.fulfill({ json: models });
		} else if (path.endsWith("/providers"))
			await route.fulfill({ json: providers });
		else if (path.endsWith("/catalog"))
			await route.fulfill({ json: { providers: {} } });
		else {
			unexpected.push(path);
			await route.abort();
		}
	});
	return { release, unexpected };
}

for (const width of [320, 768, 1280])
	for (const colorScheme of ["light", "dark"] as const) {
		test(`loading and completion fit ${width}px ${colorScheme}`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 800 });
			await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
			const { release, unexpected } = await holdModels(page);
			await page.goto("/browser/loading.html");
			const banner = page
				.getByRole("status")
				.filter({ hasText: "Loading models…" });
			await expect(banner).toBeVisible();
			await expect(banner).toHaveAttribute("aria-live", "polite");
			await expect(banner).toHaveAttribute("aria-atomic", "true");
			expect(
				await banner.evaluate((el) => el.closest('[aria-busy="true"]')),
			).toBeNull();
			expect(await banner.locator("[aria-hidden=true]").count()).toBe(2);
			await expect(
				page.getByRole("button", { name: "Refreshing…" }),
			).toBeDisabled();
			const orbit = banner.locator(".loading-banner-orbit");
			const before = await orbit.evaluate(
				(el) => getComputedStyle(el, "::before").transform,
			);
			await expect
				.poll(() =>
					orbit.evaluate((el) => getComputedStyle(el, "::before").transform),
				)
				.not.toBe(before);
			const bounds = await banner.boundingBox();
			expect(bounds?.x).toBeGreaterThanOrEqual(0);
			expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
				width,
			);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth),
			).toBeLessThanOrEqual(width);
			await page.screenshot({
				path: `test-results/loading-${width}-${colorScheme}.png`,
				fullPage: true,
			});
			release();
			await expect(
				page.getByText("local/synthetic-model", { exact: true }),
			).toBeVisible();
			await expect(banner).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: "Refresh", exact: true }),
			).toBeEnabled();
			await expect(
				page.getByRole("region", { name: "Active models" }),
			).toHaveAttribute("aria-busy", "false");
			expect(unexpected).toEqual([]);
		});
	}

test("reduced motion and compact long labels remain static and fit", async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 640 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/browser/loading.html?view=compact");
	const banner = page.getByRole("status");
	await expect(banner).toBeVisible();
	expect(
		await banner
			.locator(".loading-banner-orbit")
			.evaluate((el) => getComputedStyle(el, "::before").animationName),
	).toBe("none");
	expect(
		await banner
			.locator(".loading-banner-track span")
			.evaluate((el) => getComputedStyle(el).animationName),
	).toBe("none");
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
		320,
	);
	await page.emulateMedia({ forcedColors: "active" });
	await expect(banner).toBeVisible();
	expect(
		await banner
			.locator(".loading-banner-track")
			.evaluate((el) => getComputedStyle(el).display),
	).toBe("none");
});

test("failed initial load stops motion, retry succeeds, and refresh preserves data and focus", async ({
	page,
}) => {
	let fail = true;
	let release = () => {};
	let pending = Promise.resolve();
	await page.route("**/v1/**", async (route) => {
		await pending;
		const path = new URL(route.request().url()).pathname;
		await route.fulfill(
			fail
				? { status: 503, json: {} }
				: {
						json: path.endsWith("/catalog")
							? { providers: {} }
							: path.endsWith("/providers")
								? providers
								: models,
					},
		);
	});
	await page.goto("/browser/loading.html");
	await expect(page.getByRole("alert")).toContainText(
		"Could not load active models",
	);
	await expect(page.locator(".loading-banner")).toHaveCount(0);
	fail = false;
	pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.locator(".loading-banner")).toBeVisible();
	release();
	await expect(
		page.getByText("local/synthetic-model", { exact: true }),
	).toBeVisible();
	pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const refresh = page.getByRole("button", { name: "Refresh", exact: true });
	await refresh.focus();
	await refresh.press("Enter");
	await expect(
		page.getByRole("region", { name: "Active models" }),
	).toHaveAttribute("aria-busy", "true");
	await expect(
		page.getByText("local/synthetic-model", { exact: true }),
	).toBeVisible();
	await expect(page.locator(".loading-banner")).toHaveCount(0);
	const search = page.getByRole("searchbox", { name: "Search active models" });
	await search.focus();
	release();
	await expect(refresh).toBeEnabled();
	await expect(search).toBeFocused();
});

test("app gate clears its status when setup is ready", async ({ page }) => {
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/v1/**", async (route) => {
		await pending;
		await route.fulfill({
			json: {
				setupComplete: false,
				setupTokenRequired: false,
				persistence: "memory",
			},
		});
	});
	await page.goto("/browser/loading.html?view=app");
	await expect(page.locator(".loading-banner")).toBeVisible();
	release();
	await expect(page.locator(".loading-banner")).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Create your account", exact: true }),
	).toBeVisible();
});

test("dashboard loading becomes an actionable failure with no residual motion", async ({
	page,
}) => {
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/v1/**", async (route) => {
		await pending;
		await route.fulfill({ status: 503, json: {} });
	});
	await page.goto("/browser/loading.html?view=dashboard");
	await expect(
		page.getByText("Loading the overview…", { exact: true }),
	).toBeVisible();
	await page.getByRole("tab", { name: "Usage", exact: true }).click();
	await expect(
		page.getByText("Loading usage analytics…", { exact: true }),
	).toBeVisible();
	release();
	await expect(page.getByRole("alert")).toContainText(
		"Could not refresh analytics",
	);
	await expect(page.locator(".loading-banner")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Retry", exact: true }),
	).toBeEnabled();
});

for (const width of [320, 1280])
	test(`proposal loading resolves to a spacious empty state at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 640 });
		await page.emulateMedia({ colorScheme: "dark" });
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/v1/**", async (route) => {
			await pending;
			await route.fulfill({ json: { proposals: [] } });
		});
		await page.goto("/browser/loading.html?view=proposals");
		await expect(
			page.getByText("Loading proposals…", { exact: true }),
		).toBeVisible();
		release();
		const empty = page.getByRole("region", { name: "No pending proposals" });
		await expect(empty).toBeVisible();
		await expect(page.locator(".loading-banner")).toHaveCount(0);
		expect(
			await empty.evaluate((el) =>
				parseFloat(getComputedStyle(el).paddingLeft),
			),
		).toBeGreaterThanOrEqual(16);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth),
		).toBeLessThanOrEqual(width);
		await page.screenshot({
			path: `test-results/proposals-empty-${width}-dark.png`,
			fullPage: true,
		});
	});

test("proposal load failure does not claim the queue is empty", async ({
	page,
}) => {
	await page.route("**/v1/**", (route) =>
		route.fulfill({ status: 503, json: {} }),
	);
	await page.goto("/browser/loading.html?view=proposals");
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(page.locator(".loading-banner")).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "No pending proposals" }),
	).toHaveCount(0);
});
