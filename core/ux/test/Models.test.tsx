import {
	type ApiConfig,
	createServer,
	ModelCatalogService,
} from "@autonomo.us/server";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { clearCredential } from "../src/api.js";
import { defaultWorkspaceId, setUpOwner } from "./session.js";

// The model field renders against a real gateway API server (no fetch mocks)
// with a fixed catalog, so the daily models.json refresh cannot change what
// these tests see.

const CATALOG = {
	updated: "2026-01-01T00:00:00.000Z",
	providers: {
		openai: {
			name: "OpenAI",
			source: "documentation" as const,
			models: [
				{
					id: "gpt-alpha",
					name: "GPT Alpha",
					released: "2026-07-09",
					pricing: { input: 4, output: 20 },
				},
				{
					id: "gpt-alpha-mini",
					name: "GPT Alpha mini",
					released: "2026-03",
					pricing: { input: 0.2, output: 1.25 },
				},
				{ id: "gpt-beta", name: "GPT Beta" },
				{
					id: "open-weights",
					name: "Open Weights",
					pricing: { input: 0, output: 0 },
				},
				{ id: "text-embedding-9", name: "Embedding 9" },
			],
		},
	},
};

const closers: Array<() => Promise<unknown>> = [];

async function openForm(provider = "openai") {
	const config: ApiConfig = {
		providers: [
			{
				kind: "openai",
				name: "openai",
				apiKey: "secret",
				models: ["gpt-beta"],
			},
		],
		corsOrigins: ["*"],
	};
	const server = createServer({
		config,
		modelCatalog: new ModelCatalogService({ base: CATALOG }),
		logger: false,
	});
	const url = await server.listen({ port: 0, host: "127.0.0.1" });
	closers.push(() => server.close());
	vi.stubEnv("VITE_API_URL", url);
	const token = await setUpOwner(url);
	const workspaceId = await defaultWorkspaceId(url, token);
	window.history.replaceState(null, "", "#/models");
	render(<App />);
	await screen.findByText("openai/gpt-beta");
	fireEvent.click(screen.getByRole("button", { name: "Add model" }));
	fireEvent.change(screen.getByLabelText("Provider"), {
		target: { value: provider },
	});
	return {
		field: screen.getByLabelText("Model") as HTMLInputElement,
		models: async () =>
			(
				(await (
					await fetch(`${url}/v1/${workspaceId}/models`, {
						headers: { authorization: `Bearer ${token}` },
					})
				).json()) as { models: Array<{ id: string }> }
			).models.map((item) => item.id),
	};
}

// Scoped to the suggestion list: the form's selects have options of their own.
const options = () => {
	const list = screen.queryByRole("listbox", { name: "Model suggestions" });
	return list ? within(list).queryAllByRole("option") : [];
};
const highlighted = () =>
	options().find((item) => item.getAttribute("aria-selected") === "true");

describe("Model field", () => {
	afterEach(async () => {
		cleanup();
		clearCredential();
		window.history.replaceState(null, "", "/");
		window.localStorage.clear();
		vi.unstubAllEnvs();
		for (const close of closers.splice(0)) await close();
	});

	it("lists the provider's chat models with price, release date and what is active", async () => {
		const { field } = await openForm();
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(field.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(field);
		expect(field.getAttribute("aria-expanded")).toBe("true");
		const list = screen.getByRole("listbox", { name: "Model suggestions" });
		expect(options().map((item) => item.textContent)).toEqual([
			"GPT Alphagpt-alpha$4 / $20Jul 2026",
			"GPT Alpha minigpt-alpha-mini$0.2 / $1.25Mar 2026",
			"GPT BetaActivegpt-beta",
			"Open Weightsopen-weightsFree",
		]);
		expect(within(list).queryByText("text-embedding-9")).toBeNull();
		expect(screen.getByRole("status").textContent).toBe("4 models");
		expect(highlighted()).toBeUndefined();
		fireEvent.blur(field);
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("narrows the list while typing and adds the model picked with the keyboard", async () => {
		const { field, models } = await openForm();
		fireEvent.change(field, { target: { value: "ALPHA mini" } });
		expect(options()).toHaveLength(1);
		expect(options()[0]?.textContent).toContain("gpt-alpha-mini");
		expect(screen.getByRole("status").textContent).toBe("1 of 4 models");
		// The closest id comes first, whatever the catalog's order.
		fireEvent.change(field, { target: { value: "gpt-alpha-m" } });
		expect(options()).toHaveLength(1);
		fireEvent.change(field, { target: { value: "gpt" } });
		expect(options()).toHaveLength(3);
		fireEvent.keyDown(field, { key: "ArrowDown" });
		fireEvent.keyDown(field, { key: "ArrowDown" });
		expect(highlighted()?.textContent).toContain("gpt-alpha-mini");
		expect(field.getAttribute("aria-activedescendant")).toBe(highlighted()?.id);
		fireEvent.keyDown(field, { key: "ArrowUp" });
		fireEvent.keyDown(field, { key: "ArrowUp" });
		expect(highlighted()?.textContent).toContain("gpt-beta");
		fireEvent.keyDown(field, { key: "ArrowDown" });
		fireEvent.keyDown(field, { key: "ArrowDown" });
		expect(highlighted()?.textContent).toContain("gpt-alpha-mini");
		fireEvent.keyDown(field, { key: "Enter" });
		expect(field.value).toBe("gpt-alpha-mini");
		expect(screen.queryByRole("listbox")).toBeNull();
		fireEvent.click(
			within(screen.getByRole("region", { name: "Add a model" })).getByRole(
				"button",
				{ name: "Add model" },
			),
		);
		await screen.findByText("openai/gpt-alpha-mini is now active.");
		expect(await models()).toContain("openai/gpt-alpha-mini");
	});

	it("reopens on the chosen model and picks another with the mouse", async () => {
		const { field } = await openForm();
		fireEvent.keyDown(field, { key: "ArrowUp" });
		expect(highlighted()?.textContent).toContain("open-weights");
		fireEvent.keyDown(field, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		fireEvent.change(field, { target: { value: "gpt-alpha-mini" } });
		fireEvent.keyDown(field, { key: "Escape" });
		// The whole catalog is back, with the chosen model highlighted.
		const toggle = screen.getByRole("button", {
			name: "Show model suggestions",
		});
		fireEvent.mouseDown(toggle);
		expect(options()).toHaveLength(4);
		expect(highlighted()?.textContent).toContain("gpt-alpha-mini");
		expect(highlighted()?.hasAttribute("data-current")).toBe(true);
		const first = options()[0] as HTMLElement;
		fireEvent.mouseMove(first);
		expect(highlighted()).toBe(first);
		fireEvent.mouseDown(first);
		expect(field.value).toBe("gpt-alpha");
		expect(screen.queryByRole("listbox")).toBeNull();
		fireEvent.mouseDown(toggle);
		fireEvent.mouseDown(
			screen.getByRole("button", { name: "Hide model suggestions" }),
		);
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("opens above the field when there is no room below, however it is opened", async () => {
		const { field } = await openForm();
		const popover = () => document.querySelector(".model-combobox-popover");
		fireEvent.change(field, { target: { value: "gpt" } });
		expect(popover()?.classList.contains("above")).toBe(false);
		fireEvent.keyDown(field, { key: "Escape" });
		// The field now sits at the bottom of the window.
		const bottom = window.innerHeight - 20;
		field.getBoundingClientRect = () =>
			({ top: bottom - 40, bottom }) as DOMRect;
		fireEvent.change(field, { target: { value: "gpt-" } });
		expect(popover()?.classList.contains("above")).toBe(true);
		fireEvent.keyDown(field, { key: "Escape" });
		fireEvent.click(field);
		expect(popover()?.classList.contains("above")).toBe(true);
	});

	it("takes a model id the catalog does not list", async () => {
		const { field } = await openForm();
		fireEvent.change(field, { target: { value: "my-fine-tune" } });
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(
			screen.getByText(/No suggestions match “my-fine-tune”/),
		).toBeDefined();
		expect(screen.getByRole("status").textContent).toBe("0 of 4 models");
		// Enter with nothing highlighted is left to the form.
		expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(true);
		expect(field.value).toBe("my-fine-tune");
		expect(
			screen.getByText(
				"Not in the suggested list. It is sent to OpenAI as entered.",
			),
		).toBeDefined();
		fireEvent.change(field, { target: { value: "gpt-beta" } });
		expect(screen.getByText("This model is already active.")).toBeDefined();
	});

	it("is a plain text box for a provider without suggestions", async () => {
		const { field } = await openForm("groq");
		expect(field.placeholder).toBe("Enter a model ID");
		expect(
			screen.queryByRole("button", { name: "Show model suggestions" }),
		).toBeNull();
		fireEvent.click(field);
		fireEvent.keyDown(field, { key: "ArrowDown" });
		fireEvent.change(field, { target: { value: "llama" } });
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(field.getAttribute("aria-expanded")).toBe("false");
		expect(
			screen.getByText("Enter a model ID from your provider."),
		).toBeDefined();
	});
});
