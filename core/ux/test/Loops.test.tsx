import type {
	CreateLoop,
	LoopDetail,
	LoopObservationInput,
} from "@autonomo.us/common";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
	continuityRequest,
	seedRustboy,
} from "../../server/scripts/fixtures/rustboy.js";
import { createServer } from "../../server/src/server.js";
import { App } from "../src/App.js";
import { clearCredential, setSessionToken } from "../src/api.js";
import { stopServer } from "./session.js";

let gateway: ReturnType<typeof createServer> | undefined;
afterEach(async () => {
	cleanup();
	clearCredential();
	window.history.replaceState(null, "", "/");
	vi.unstubAllEnvs();
	if (gateway) await stopServer(gateway);
});

async function seedLoopStudio(server: ReturnType<typeof createServer>) {
	const studio = await seedRustboy(server);
	for (const agent of [studio.editor, studio.artist]) {
		const result = await server.inject({
			method: "PATCH",
			url: `/v1/${studio.workspaceId}/agent-tokens/${agent.identity.id}`,
			headers: { authorization: `Bearer ${studio.owner.token}` },
			payload: {
				name: agent === studio.artist ? "Iris" : "Splice",
				description: "Studio fixture",
				permissions: [
					"mcp:read",
					"mcp:call",
					"loops:read",
					"loops:act",
					...(agent === studio.artist ? ["organization:decide"] : []),
				],
			},
		});
		expect(result.statusCode, result.body).toBe(200);
	}
	return studio;
}

it("opens the counted decision queue from a metric card and preserves the workflow version for an active run", async () => {
	gateway = createServer({
		config: { providers: [], corsOrigins: ["*"] },
		logger: false,
	});
	const studio = await seedLoopStudio(gateway);
	const input: CreateLoop = {
		name: "Shot continuity",
		goal: "Accept more shots on the first render.",
		ownerPositionId: studio.captain.id,
		metric: {
			name: "First-pass acceptance",
			source: "Studio QC",
			direction: "at_least",
			target: 80,
			staleAfterMinutes: 1440,
		},
		workflow: {
			decisionKey: "visual-continuity",
			triggerCount: 1,
			steps: [
				{
					id: "review",
					name: "Approve a new reference",
					kind: "decision",
					assignee: null,
				},
				{
					id: "render",
					name: "Render once",
					kind: "action",
					assignee: studio.editor.identity,
					maxCostCents: 80,
				},
				{
					id: "check",
					name: "Verify screen direction",
					kind: "verify",
					assignee: studio.artist.identity,
				},
			],
		},
	};
	const base = `/v1/${studio.workspaceId}/loops`;
	const headers = { authorization: `Bearer ${studio.owner.token}` };
	const created = await gateway.inject({
		method: "POST",
		url: base,
		headers,
		payload: input,
	});
	expect(created.statusCode, created.body).toBe(201);
	const loop = created.json<LoopDetail>();
	const measurement: LoopObservationInput = {
		eventId: "studio-1",
		workId: "Shot 014",
		workRevision: "cut-3",
		observedAt: new Date().toISOString(),
		numerator: 18,
		denominator: 25,
		trigger: true,
		evidence: "work:render-014",
	};
	const observation = await gateway.inject({
		method: "POST",
		url: `${base}/${loop.id}/observations`,
		headers,
		payload: measurement,
	});
	expect(observation.statusCode, observation.body).toBeLessThan(300);
	vi.stubEnv(
		"VITE_API_URL",
		await gateway.listen({ host: "127.0.0.1", port: 0 }),
	);
	setSessionToken(studio.owner.token);
	window.location.hash = `#/w/${studio.workspaceId}/loops`;
	render(<App />);
	const card = await screen.findByRole("article", { name: "Shot continuity" });
	expect(within(card).getByText("72%")).toBeTruthy();
	expect(within(card).getByText("Target ≥ 80%")).toBeTruthy();
	fireEvent.click(
		within(card).getByRole("link", {
			name: "Inspect First-pass acceptance at 72%",
		}),
	);
	await screen.findByLabelText("Measurement day (UTC)");
	await screen.findByRole("columnheader", { name: "Contribution" });
	fireEvent.click(screen.getByRole("link", { name: "All loops" }));
	const updatedCard = await screen.findByRole("article", {
		name: "Shot continuity",
	});
	fireEvent.click(
		within(updatedCard).getByRole("link", { name: "1 pending decision" }),
	);
	await waitFor(() =>
		expect(
			screen
				.getByRole("tab", { name: "Decisions (1)" })
				.getAttribute("aria-selected"),
		).toBe("true"),
	);
	fireEvent.click(
		await screen.findByRole("link", { name: "View workflow run" }),
	);
	await screen.findByRole("heading", { name: "Run activity" });
	fireEvent.click(screen.getByRole("tab", { name: "Design" }));
	fireEvent.click(await screen.findByRole("button", { name: "Edit workflow" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Step name" }), {
		target: { value: "Review continuity evidence" },
	});
	fireEvent.change(screen.getByRole("spinbutton", { name: "Target (%)" }), {
		target: { value: "76" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Publish workflow" }));
	await screen.findByText("Published v2");
	fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
	await screen.findByText(/Workflow v1/);
	expect(screen.getByText("Approve a new reference")).toBeTruthy();
	fireEvent.click(screen.getByRole("link", { name: "All loops" }));
	await screen.findByText("Target ≥ 76%");
});

it("builds a loop from an empty workspace and requires an independent verifier", async () => {
	gateway = createServer({
		config: { providers: [], corsOrigins: ["*"] },
		logger: false,
	});
	const studio = await seedLoopStudio(gateway);
	vi.stubEnv(
		"VITE_API_URL",
		await gateway.listen({ host: "127.0.0.1", port: 0 }),
	);
	setSessionToken(studio.owner.token);
	window.location.hash = `#/w/${studio.workspaceId}/loops`;
	render(<App />);
	await screen.findByRole("heading", { name: "No loops yet" });
	fireEvent.click(screen.getByRole("button", { name: "New loop" }));
	const fill = (name: string, value: string) =>
		fireEvent.change(screen.getByLabelText(name), { target: { value } });
	fill("Loop name", "Render acceptance");
	fill("Outcome", "Improve the shoot.");
	fill("Metric name", "First-pass rate");
	fill("Data source", "QC");
	fill("Target (%)", "80");
	fill("Decision rule key", "visual-continuity");
	fireEvent.click(screen.getByRole("button", { name: "Accountable position" }));
	const directorOption = { name: /Studio Director · Captain/ };
	await screen.findByRole("button", directorOption);
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "Studio Director" },
	});
	expect(screen.queryByRole("button", directorOption)).toBeNull();
	fireEvent.click(await screen.findByRole("button", directorOption));
	expect(
		screen
			.getByRole("button", { name: "Accountable position" })
			.getAttribute("aria-expanded"),
	).toBe("false");
	fireEvent.click(screen.getByRole("button", { name: /2 · action/ }));
	fireEvent.click(screen.getByRole("button", { name: "Assigned to" }));
	fireEvent.click(
		await screen.findByRole("button", { name: /Splice · Token agent/ }),
	);
	fireEvent.click(screen.getByRole("button", { name: /3 · verify/ }));
	fireEvent.click(screen.getByRole("button", { name: "Independent verifier" }));
	fireEvent.click(
		await screen.findByRole("button", { name: /Splice · Token agent/ }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Create loop" }));
	await screen.findByText(
		"Assign verification to someone independent of the action and tasks.",
	);
	fireEvent.click(screen.getByRole("button", { name: "Independent verifier" }));
	fireEvent.click(
		await screen.findByRole("button", { name: /Iris · Token agent/ }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Create loop" }));
	await screen.findByRole("heading", { name: "Render acceptance" });
	expect(screen.getByText("No data")).toBeTruthy();
	expect(
		screen.getByText("Waiting for the first observation from QC."),
	).toBeTruthy();
});

it("updates an open Decisions tab when an agent reports a case and preserves the selected case and draft", async () => {
	gateway = createServer({
		config: { providers: [], corsOrigins: ["*"] },
		logger: false,
	});
	const studio = await seedRustboy(gateway);
	vi.stubEnv(
		"VITE_API_URL",
		await gateway.listen({ host: "127.0.0.1", port: 0 }),
	);
	setSessionToken(studio.owner.token);
	window.location.hash = `#/w/${studio.workspaceId}/loops/decisions`;
	render(<App />);
	await screen.findByRole("tab", { name: "Decisions (0)" });
	await screen.findByText("No decisions in this queue.");
	const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
	try {
		const first = await studio.open();
		const fetch = vi.spyOn(globalThis, "fetch");
		try {
			fireEvent.focus(window);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
		hidden.mockReturnValue(false);
		fireEvent(document, new Event("visibilitychange"));
		await screen.findByRole("tab", { name: "Decisions (1)" });
		await screen.findByRole("heading", { name: first.question });
		fireEvent.click(screen.getByRole("button", { name: "Request a decision" }));
		fireEvent.change(screen.getByLabelText("Question"), {
			target: { value: "My draft" },
		});
		const second = "May the next shot use the same reference?";
		await studio.tool(studio.editor.secret, "organization_open_case", {
			...continuityRequest,
			requesterPositionId: studio.splice.id,
			sourceWorkId: "rustboy/shot-015",
			question: second,
		});
		fireEvent.focus(window);
		await screen.findByRole("tab", { name: "Decisions (2)" });
		expect(
			(screen.getByLabelText("Question") as HTMLTextAreaElement).value,
		).toBe("My draft");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await screen.findByRole("link", { name: new RegExp(second.slice(0, -1)) });
		expect(screen.getByRole("heading", { name: first.question })).toBeTruthy();
	} finally {
		hidden.mockRestore();
	}
});
