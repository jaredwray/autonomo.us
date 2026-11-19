import type { DecisionCase } from "@autonomo.us/common";
import { createServer } from "@autonomo.us/server";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { seedRustboy } from "../../server/scripts/fixtures/rustboy.js";
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

it("links a reporting position to its decision route and lets the assigned human resolve the case", async () => {
	gateway = createServer({
		config: { providers: [], corsOrigins: ["*"] },
		logger: false,
	});
	const s = await seedRustboy(gateway);
	const record = await s.open();
	const handed = await s.tool<DecisionCase>(
		s.artist.secret,
		"organization_act",
		{
			caseId: record.id,
			action: "handoff",
			targetPositionId: s.jared.id,
			expectedRevision: record.revision,
			reason: "Producer review requested.",
		},
	);
	expect(handed.assignee?.name).toBe("Jared");
	const url = await gateway.listen({ host: "127.0.0.1", port: 0 });
	vi.stubEnv("VITE_API_URL", url);
	setSessionToken(s.owner.token);
	window.location.hash = `#/w/${s.workspaceId}/organization/positions/${s.splice.id}`;
	render(<App />);
	const details = await screen.findByRole("complementary", {
		name: "Position details",
	});
	expect(
		within(details).getByRole("heading", { name: "Shot Editor" }),
	).toBeTruthy();
	expect(
		within(details).getByRole("link", { name: "Studio Director" }),
	).toBeTruthy();
	fireEvent.keyDown(screen.getByRole("tab", { name: "Reporting" }), {
		key: "ArrowRight",
	});
	const route = await screen.findByRole("list", { name: "Decision route" });
	expect(
		within(route)
			.getAllByRole("link")
			.map((a) => a.textContent),
	).toEqual(["Shot Editor", "Art Director", "Executive Producer"]);
	expect(screen.getByText(/Response window 30 min/)).toBeTruthy();
	fireEvent.click(screen.getByRole("link", { name: "Loops" }));
	fireEvent.click(await screen.findByRole("tab", { name: /^Decisions/ }));
	await screen.findByRole("heading", { name: record.question });
	expect(screen.getByText("Rejected cut")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
		target: { value: "Match the original silhouette." },
	});
	fireEvent.click(screen.getByRole("button", { name: "Submit changes" }));
	await screen.findByRole("heading", { name: "Outcome" });
	await waitFor(() =>
		expect(window.location.hash).toContain(`/cases/${record.id}`),
	);
	expect(
		screen.getAllByText(/Match the original silhouette/).length,
	).toBeGreaterThan(0);
	expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
});
