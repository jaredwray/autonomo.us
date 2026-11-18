import { createServer } from "@autonomo.us/server";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import {
	clearCredential,
	setCurrentWorkspace,
	setSessionToken,
} from "../src/api.js";
import { parseSynapseRoute, synapseHash } from "../src/synapse-route.js";
import { changeControl, dropdownOptions } from "./controls.js";
import {
	defaultWorkspaceId,
	PASSWORD,
	routeToWorkspace,
	setUpOwner,
	stopServer,
} from "./session.js";

// Synapse's knowledge features (capture, retrieval, commitments, maintenance,
// and a note's standing, evidence, and history) against a real gateway API
// server, the way Synapse.test.tsx drives the notes: no fetch mocks.

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	cleanup();
	clearCredential();
	for (const close of closers.splice(0)) await close();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
	window.localStorage.clear();
	window.sessionStorage.clear();
});

type Running = {
	server: ReturnType<typeof createServer>;
	url: string;
	owner: Record<string, string>;
};
async function boot({ signIn = true } = {}): Promise<Running> {
	const server = createServer({
		config: { providers: [], corsOrigins: ["*"] },
		logger: false,
	});
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	closers.push(() => stopServer(server));
	vi.stubEnv("VITE_API_URL", url);
	const token = await setUpOwner(url, { signIn });
	// Synapse lives in a workspace; these tests use the default one.
	routeToWorkspace(server, await defaultWorkspaceId(url, token));
	return { server, url, owner: { authorization: `Bearer ${token}` } };
}
function renderAt(hash: string) {
	window.history.replaceState(null, "", hash);
	render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
/** Seeds the space through the API, then opens the dashboard at `hash`. */
async function start(
	hash: string,
	seed: (running: Running) => Promise<unknown> = async () => {},
) {
	const running = await boot();
	await seed(running);
	renderAt(hash);
	return running;
}
/** Synapse URLs sit inside the selected workspace: #/w/<id>/synapse/... */
const expectHash = (path: string) =>
	expect(window.location.hash).toBe(
		`#/w/${window.location.hash.split("/")[2]}/${path}`,
	);
const change = (label: string | RegExp, value: string) =>
	changeControl(screen.getByLabelText(label), { target: { value } });
const region = (name: string | RegExp) => screen.findByRole("region", { name });
const tab = (name: string) => screen.getByRole("tab", { name });
const spaceValue = () => screen.getByLabelText("Space").textContent;
/**
 * Picks a space once the list of spaces has loaded, which the hint shows by
 * naming its time zone. Opening the dropdown inside `waitFor` to look would
 * change the page on every check, and each change re-runs the check before
 * the response can arrive: it would never end.
 */
const pickSpace = async (id: string) => {
	await screen.findByText(/Dates and daily notes use/);
	const select = screen.getByLabelText("Space") as HTMLSelectElement;
	expect(
		dropdownOptions(select).map((option) => option.getAttribute("data-value")),
	).toContain(id);
	changeControl(select, { target: { value: id } });
};

async function api(
	{ server, owner }: Running,
	method: "GET" | "POST" | "PATCH",
	path: string,
	payload?: Record<string, unknown>,
) {
	const response = await server.inject({
		method,
		url: `/v1/synapse/spaces/${path}`,
		headers: owner,
		...(payload ? { payload } : {}),
	});
	return response;
}
async function createNote(
	running: Running,
	space: string,
	payload: Record<string, unknown>,
) {
	const response = await api(running, "POST", `${space}/notes`, payload);
	expect(response.statusCode, response.body).toBe(201);
	return response.json();
}
const notePath = (title: string) => `shared/notes/${encodeURIComponent(title)}`;
async function readNote(running: Running, title: string) {
	return api(running, "GET", notePath(title));
}
async function editNote(
	running: Running,
	title: string,
	payload: Record<string, unknown>,
) {
	const response = await api(running, "PATCH", notePath(title), payload);
	expect(response.statusCode, response.body).toBe(200);
}

it("gives each tab an address, and leaves a note titled like a tab reachable in its space", () => {
	// Outside a workspace, as on first load; inside one the address starts #/w/<id>.
	setCurrentWorkspace(null);
	const shared = { space: "shared", title: null };
	for (const name of [
		"capture",
		"ask",
		"commitments",
		"maintenance",
	] as const) {
		expect(parseSynapseRoute(`#/w/ws-1/synapse/${name}`)).toEqual({
			...shared,
			tab: name,
		});
		expect(parseSynapseRoute(`#/synapse/${name}`).tab).toBe(name);
		// A tab's address carries no space: the view keeps the one it shows.
		expect(synapseHash({ tab: name, space: "global", title: null })).toBe(
			`#/synapse/${name}`,
		);
		// Only the segment right after `synapse` names a tab.
		expect(parseSynapseRoute(`#/w/ws-1/synapse/global/${name}`)).toEqual({
			tab: "notes",
			space: "global",
			title: name,
		});
	}
	expect(parseSynapseRoute("#/synapse/proposals").tab).toBe("proposals");
	expect(parseSynapseRoute("#/synapse/notes")).toEqual({
		...shared,
		tab: "notes",
	});
	expect(synapseHash({ tab: "notes", space: "shared", title: "capture" })).toBe(
		"#/synapse/shared/capture",
	);
});

it("orders the tabs, keeps the chosen space across them, and opens a note titled “capture”", async () => {
	await start("#/synapse/shared/capture", (running) =>
		createNote(running, "shared", { title: "capture", body: "A note." }),
	);
	// The address of a note in a space, whatever its title.
	await screen.findByRole("heading", { name: "capture" });
	expect(tab("Notes").getAttribute("aria-selected")).toBe("true");
	expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
		"Notes",
		"Save to Synapse",
		"Ask",
		"Commitments",
		"Maintenance",
		"Proposals",
	]);
	fireEvent.click(tab("Save to Synapse"));
	expectHash("synapse/capture");
	expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
		"synapse-tab-capture",
	);
	await region("Save to Synapse");
	await pickSpace("global");
	// Choosing a space stays on the tab, and the next tabs act on it.
	expectHash("synapse/capture");
	expect(spaceValue()).toContain("Global");
	for (const [name, path, heading] of [
		["Ask", "synapse/ask", "Ask"],
		["Commitments", "synapse/commitments", "Commitments"],
		["Maintenance", "synapse/maintenance", null],
	] as const) {
		fireEvent.click(tab(name));
		expectHash(path);
		expect(tab(name).getAttribute("aria-selected")).toBe("true");
		expect(spaceValue()).toContain("Global");
		if (heading) await region(heading);
	}
	await screen.findByText(/Synapse checks this space every 24 hours/);
	// Back on Notes, the space is still the one chosen.
	fireEvent.click(tab("Notes"));
	expectHash("synapse/global");
	// Arriving at a tab's address, as Back does, keeps the space too.
	window.location.hash = window.location.hash.replace(
		/synapse.*$/,
		"synapse/maintenance",
	);
	await waitFor(() =>
		expect(tab("Maintenance").getAttribute("aria-selected")).toBe("true"),
	);
	expect(spaceValue()).toContain("Global");
});

it("saves text and a document to Synapse and shows the source, the notes it mentions, and their updates", async () => {
	const running = await start("#/synapse/capture", (seeded) =>
		createNote(seeded, "shared", { title: "Ada Lovelace", template: "People" }),
	);
	const form = within(await region("Save to Synapse"));
	const save = form.getByRole("button", { name: "Save to Synapse" });
	expect((save as HTMLButtonElement).disabled).toBe(true);
	change("Page address (URL)", "https://example.com/notes");
	change(
		"Text",
		"# Notes on the Engine\nAda Lovelace wrote the first program.",
	);
	fireEvent.click(save);
	const saved = within(await region("What was saved"));
	expect(
		saved.getByText(
			'Saved "Notes on the Engine" as a new source. It mentions 1 existing note. Updates: 1 prepared.',
		),
	).toBeDefined();
	expect(saved.getByText("Created")).toBeDefined();
	expect(
		saved.getByRole("link", { name: "https://example.com/notes" }),
	).toBeDefined();
	const entities = within(
		saved.getByRole("region", { name: /^Notes it mentions \(1\)/ }),
	);
	expect(entities.getByRole("link", { name: "Ada Lovelace" })).toBeDefined();
	expect(entities.getByText("People")).toBeDefined();
	expect(entities.getByText("1 mention")).toBeDefined();
	expect(
		entities.getByText("Ada Lovelace wrote the first program."),
	).toBeDefined();
	const prepared = within(
		saved.getByRole("region", { name: /^Updates to those notes \(1\)/ }),
	);
	expect(prepared.getByText("Prepared")).toBeDefined();
	expect(
		prepared.getByText(
			/^- \[\[Notes on the Engine\]\] \(r1, .*wrote the first program\."$/,
		),
	).toBeDefined();
	// Nothing was written to the mentioned note yet.
	expect(
		(await readNote(running, "Ada Lovelace")).json().note.body,
	).not.toContain("Notes on the Engine");

	// The same address with other text is a new version of the same source.
	change(
		"Text",
		"# Notes on the Engine\nAda Lovelace wrote the first algorithm.",
	);
	fireEvent.click(screen.getByLabelText("Also update the notes it mentions"));
	fireEvent.click(save);
	await waitFor(() =>
		expect(
			within(screen.getByRole("region", { name: "What was saved" })).getByText(
				"Updated",
			),
		).toBeDefined(),
	);
	const updated = within(
		screen.getByRole("region", { name: "What was saved" }),
	);
	const diff = within(
		updated.getByRole("region", {
			name: /^What changed since the last version/,
		}),
	);
	expect(
		diff.getByText(
			/^\+ Ada Lovelace wrote the first algorithm\. - Ada Lovelace wrote the first program\.$/,
		),
	).toBeDefined();
	expect(updated.getByText("Applied")).toBeDefined();
	expect((await readNote(running, "Ada Lovelace")).json().note.body).toContain(
		"## Mentions\n- [[Notes on the Engine]] (r2,",
	);

	// Pasted text and a document together are one thing too many.
	const document = new File(["Signed by Ada Lovelace."], "contract.md", {
		type: "text/markdown",
	});
	changeControl(screen.getByLabelText("Text document"), {
		target: { files: [document] },
	});
	fireEvent.click(save);
	expect((await screen.findByRole("alert")).textContent).toMatch(
		/pasted text or a document, not both/,
	);
	change("Text", "");
	change("Page address (URL)", "");
	change("Title (optional)", "Signed contract");
	fireEvent.click(save);
	await waitFor(() =>
		expect(
			within(screen.getByRole("region", { name: "What was saved" })).getByRole(
				"link",
				{ name: "Signed contract" },
			),
		).toBeDefined(),
	);
	expect(screen.queryByRole("alert")).toBeNull();
	const contract = (await readNote(running, "Signed contract")).json();
	expect(contract.note.body).toBe("Signed by Ada Lovelace.");
	expect(contract.note.properties).toMatchObject({
		kind: "document",
		file: "contract.md",
	});
	// The source's link opens the note in the space it was saved to.
	fireEvent.click(
		within(screen.getByRole("region", { name: "What was saved" })).getByRole(
			"link",
			{ name: "Signed contract" },
		),
	);
	await screen.findByRole("heading", { name: "Signed contract" });
	expectHash("synapse/shared/Signed%20contract");
});

it("asks a question, shows the passages and what is missing, and saves an answer a person approves", async () => {
	const running = await start("#/synapse", async (seeded) => {
		await createNote(seeded, "shared", {
			title: "Usage pricing",
			template: "Decisions",
			properties: { date: "2026-10-01" },
			body: "We price by usage from 2027-01-01.\n\n## Why\nSmall teams asked for it. See [[Billing rewrite]] and [[Overage policy]].",
		});
		await createNote(seeded, "shared", {
			title: "Billing rewrite",
			template: "Projects",
			body: "Replace the invoicing service.",
		});
		// Captured material: somebody else's words, kept in the team's space.
		const captured = await api(seeded, "POST", "shared/capture", {
			text: "# Customer interview\nThe customer found pricing by usage fair.",
		});
		expect(captured.statusCode, captured.body).toBe(200);
	});
	fireEvent.click(await screen.findByRole("tab", { name: "Ask" }));
	expectHash("synapse/ask");
	const ask = within(await region("Ask"));
	change("Question", "How is pricing decided for enterprise?");
	fireEvent.click(ask.getByRole("button", { name: "Ask" }));
	const passages = within(
		await region("Passages for “How is pricing decided for enterprise?”"),
	);
	const items = passages.getAllByRole("listitem");
	const passage = (title: string) =>
		within(
			items.find((item) =>
				within(item).queryByRole("link", { name: title }),
			) as HTMLElement,
		);
	const usage = within(items[0]);
	expect(usage.getByRole("link", { name: "Usage pricing" })).toBeDefined();
	expect(usage.getByText("Approved")).toBeDefined();
	expect(usage.getByText("2026-10-01")).toBeDefined();
	expect(usage.getByText("We price by usage from 2027-01-01.")).toBeDefined();
	// Each passage says how far it can be trusted, as the server judged it.
	// (A gateway built before captured material had a standing of its own
	// calls it approved, like any shared note.)
	const found = (
		await api(
			running,
			"GET",
			`shared/retrieve?question=${encodeURIComponent("How is pricing decided for enterprise?")}`,
		)
	).json();
	const interview = found.passages.find(
		(item: { title: string }) => item.title === "Customer interview",
	);
	expect(["source", "approved"]).toContain(interview.standing);
	expect(
		passage("Customer interview").getByText(
			interview.standing === "source" ? "Source" : "Approved",
		),
	).toBeDefined();
	expect(
		passage("Customer interview").getByText("› Customer interview"),
	).toBeDefined();
	// A note the matching one links to comes along, marked as such.
	expect(passage("Billing rewrite").getByText(/Linked from/).textContent).toBe(
		"Linked from Usage pricing",
	);
	expect(passages.getByText(/decided, enterprise/).textContent).toBe(
		"Nothing matched: decided, enterprise",
	);
	expect(
		passages.getByText(/Linked but not written yet:/).parentElement
			?.textContent,
	).toBe("Linked but not written yet: Overage policy");

	const answer = within(await region("Save as answer"));
	const saveAnswer = answer.getByRole("button", { name: "Save as answer" });
	change("Answer", "By usage, from 2027.");
	// An answer needs evidence; only passages matched by their own words are offered.
	expect((saveAnswer as HTMLButtonElement).disabled).toBe(true);
	expect(
		answer.queryByRole("checkbox", { name: /Billing rewrite/ }),
	).toBeNull();
	fireEvent.click(
		answer.getByRole("checkbox", { name: /Usage pricing: “We price by usage/ }),
	);
	// The note moved on since it was retrieved: the server says so.
	await editNote(running, "Usage pricing", { body: "We price per seat." });
	fireEvent.click(saveAnswer);
	expect((await answer.findByRole("alert")).textContent).toBe(
		'"Usage pricing" does not contain the passage cited from it. Quote its words exactly.',
	);
	await editNote(running, "Usage pricing", {
		body: "We price by usage from 2027-01-01.",
	});
	fireEvent.click(saveAnswer);
	// The saved answer opens: a draft, with its evidence checked against the source.
	await screen.findByRole("heading", {
		name: "How is pricing decided for enterprise",
	});
	expectHash("synapse/shared/How%20is%20pricing%20decided%20for%20enterprise");
	const standing = within(await region("Standing"));
	expect(standing.getByText("Draft")).toBeDefined();
	const evidence = within(await region("Evidence (1)"));
	expect(evidence.getByRole("link", { name: "Usage pricing" })).toBeDefined();
	expect(evidence.getByText("Verified")).toBeDefined();
	expect(
		evidence.getByText("We price by usage from 2027-01-01."),
	).toBeDefined();
	fireEvent.click(standing.getByRole("button", { name: "Approve" }));
	await standing.findByText("Approved by Founder");
	expect(standing.queryByText("Draft")).toBeNull();
	expect(standing.queryByRole("button", { name: "Approve" })).toBeNull();
	const stored = (
		await readNote(running, "How is pricing decided for enterprise")
	).json();
	expect(stored.note.properties).toMatchObject({
		status: ["[[Approved]]"],
		approved_by: "Founder",
		question: "How is pricing decided for enterprise?",
	});
	expect(stored.note.body).toMatch(/^By usage, from 2027\.\n\n## Evidence\n/);
});

it("creates a commitment, shows it overdue, and records a person marking it done and moving its date", async () => {
	const running = await start("#/synapse/commitments");
	const list = () => screen.getByRole("region", { name: "Commitments" });
	await within(await region("Commitments")).findByText(/No commitments yet/);
	fireEvent.click(screen.getByRole("button", { name: "New commitment" }));
	const form = within(await region("New commitment"));
	const create = form.getByRole("button", { name: "Create commitment" });
	expect((create as HTMLButtonElement).disabled).toBe(true);
	change("Title", "Ship pricing page");
	change("Owner", "Scout, Ada Lovelace");
	change("Due date (optional)", "2020-01-01");
	change("Project (optional)", "Pricing");
	change("Evidence", "channel:c1#1");
	fireEvent.click(create);
	await screen.findByText("Created “Ship pricing page”.");
	const row = () =>
		within(within(list()).getByRole("row", { name: /^Ship pricing page/ }));
	await waitFor(() => expect(row().getByText("Open")).toBeDefined());
	expect(row().getByRole("link", { name: "Ship pricing page" })).toBeDefined();
	expect(row().getByText("Scout, Ada Lovelace")).toBeDefined();
	expect(row().getByText("2020-01-01")).toBeDefined();
	expect(row().getByText("Overdue")).toBeDefined();
	expect(row().getByText("Pricing")).toBeDefined();

	// A person's word is a confirmation; the note goes into the activity.
	fireEvent.click(
		row().getByRole("button", { name: "Update Ship pricing page" }),
	);
	const update = () =>
		within(screen.getByRole("group", { name: "Update “Ship pricing page”" }));
	expect(update().queryByRole("button", { name: "Mark open" })).toBeNull();
	change("Note (optional)", "Shipped on Friday.");
	fireEvent.click(update().getByRole("button", { name: "Mark done" }));
	await screen.findByText("Marked “Ship pricing page” done.");
	await waitFor(() => expect(row().getByText("Done")).toBeDefined());
	expect(row().queryByText("Overdue")).toBeNull();
	const done = (await readNote(running, "Ship pricing page")).json();
	expect(done.note.properties.status).toEqual(["[[Done]]"]);
	expect(done.note.body).toMatch(
		/Status: Open to Done.*confirmation.*Founder.*Shipped on Friday\./,
	);

	// The status filter asks the server.
	change("Status", "open");
	await within(list()).findByText("No open commitments in this space.");
	change("Status", "done");
	await waitFor(() => expect(row().getByText("Done")).toBeDefined());

	// A calendar entry moves the date, never the status.
	fireEvent.click(
		row().getByRole("button", { name: "Update Ship pricing page" }),
	);
	const move = update().getByRole("button", { name: "Change due date" });
	expect((move as HTMLButtonElement).disabled).toBe(true);
	change("New due date", "2031-03-01");
	fireEvent.click(move);
	await screen.findByText("Moved “Ship pricing page” to 2031-03-01.");
	await waitFor(() => expect(row().getByText("2031-03-01")).toBeDefined());
	expect(row().getByText("Done")).toBeDefined();
	fireEvent.click(row().getByRole("link", { name: "Ship pricing page" }));
	await screen.findByRole("heading", { name: "Ship pricing page" });
	expectHash("synapse/shared/Ship%20pricing%20page");
});

it("runs maintenance, reloads a batch that changed under the reviewer, and applies a merge", async () => {
	const running = await start("#/synapse/maintenance", async (seeded) => {
		for (const title of [
			"Pricing page",
			"Pricing pages",
			"Billing plan",
			"Billing plans",
		])
			await createNote(seeded, "shared", { title, body: `About ${title}.` });
		// A decision that cites nothing has no automatic fix.
		await createNote(seeded, "shared", {
			title: "Usage pricing",
			template: "Decisions",
		});
	});
	await screen.findByText(/No maintenance run for this space yet/);
	expect(
		screen.getByText(/Synapse checks this space every 24 hours/),
	).toBeDefined();
	fireEvent.click(screen.getByRole("button", { name: "Run now" }));
	const digest = within(await region("Latest run"));
	expect(
		await screen.findByText("Maintenance ran: 3 findings to review."),
	).toBeDefined();
	expect(digest.getByText(/Runs every 24 hours\./)).toBeDefined();
	expect(
		within(digest.getByRole("region", { name: "What changed" })).getByText(
			/^First run: \d+ notes checked\.$/,
		),
	).toBeDefined();
	const needs = within(digest.getByRole("region", { name: "What needs you" }));
	expect(
		needs.getByText("2 possible duplicates to merge or dismiss."),
	).toBeDefined();
	expect(needs.getAllByRole("listitem")).toHaveLength(2);

	const duplicates = () =>
		within(screen.getByRole("region", { name: "Possible duplicates (2)" }));
	const pricing = () =>
		within(
			duplicates()
				.getAllByRole("listitem")
				.find((item) =>
					within(item).queryByRole("link", { name: "Pricing pages" }),
				) as HTMLElement,
		);
	// The summary's [[links]] open the notes.
	expect(
		pricing().getByRole("link", { name: "Pricing page" }).getAttribute("href"),
	).toMatch(/synapse\/shared\/Pricing%20page$/);
	expect(
		pricing().getByText(
			/Applying merges “Pricing pages” into “Pricing page” and deletes “Pricing pages”/,
		),
	).toBeDefined();
	const unsupported = within(
		screen.getByRole("region", { name: "Unsupported claims (1)" }),
	);
	expect(unsupported.getByText(/Needs an edit by hand/)).toBeDefined();

	const bar = within(
		screen.getByRole("group", { name: "Review several findings" }),
	);
	const apply = bar.getByRole("button", { name: "Apply selected" });
	const dismiss = bar.getByRole("button", { name: "Dismiss selected" });
	expect((apply as HTMLButtonElement).disabled).toBe(true);
	expect((dismiss as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(bar.getByLabelText("Select all"));
	// A finding with no fix can be dismissed, not applied.
	expect(
		bar.getByText(/^3 of 3 findings selected · 1 needs an edit by hand/),
	).toBeDefined();
	expect((apply as HTMLButtonElement).disabled).toBe(true);
	expect((dismiss as HTMLButtonElement).disabled).toBe(false);
	fireEvent.click(
		unsupported.getByRole("checkbox", {
			name: "Select unsupported claim: Usage pricing",
		}),
	);
	expect(bar.getByText("2 of 3 findings selected")).toBeDefined();
	expect((apply as HTMLButtonElement).disabled).toBe(false);

	// Someone else dismisses a finding first: this review is of an old batch.
	const batch = (await api(running, "GET", "shared/maintenance")).json().batch;
	const billing = batch.findings.find((item: { titles: string[] }) =>
		item.titles.includes("Billing plans"),
	);
	const other = await api(running, "POST", "shared/maintenance/decide", {
		ids: [billing.id],
		decision: "dismiss",
		revision: batch.revision,
	});
	expect(other.statusCode, other.body).toBe(200);
	fireEvent.click(apply);
	expect((await screen.findByRole("alert")).textContent).toMatch(
		/This batch changed while you were reviewing it.*It has been reloaded/,
	);
	// The reloaded batch shows the other reviewer's decision; nothing was applied.
	await waitFor(() =>
		expect(duplicates().getByText("Dismissed")).toBeDefined(),
	);
	expect(
		duplicates().getByText(/by Founder on \d{4}-\d{2}-\d{2}/),
	).toBeDefined();
	expect((await readNote(running, "Pricing pages")).statusCode).toBe(200);
	expect(bar.getByText("1 of 2 findings selected")).toBeDefined();
	expect(
		duplicates().queryByRole("checkbox", { name: /Billing plan/ }),
	).toBeNull();

	fireEvent.click(apply);
	await screen.findByText("Applied 1 finding.");
	expect(screen.queryByRole("alert")).toBeNull();
	expect(pricing().getByText("Applied")).toBeDefined();
	expect(pricing().getByText(/by Founder on/)).toBeDefined();
	expect(bar.getByText("0 of 1 finding selected")).toBeDefined();
	expect((await readNote(running, "Pricing pages")).statusCode).toBe(404);
	expect((await readNote(running, "Pricing page")).json().note.body).toBe(
		"About Pricing page.\n\n## Merged from Pricing pages\nAbout Pricing pages.",
	);
});

it("marks a decision superseded and disputed from its note, with links both ways", async () => {
	const running = await start(
		"#/synapse/shared/Seat%20pricing",
		async (seeded) => {
			for (const title of ["Seat pricing", "Usage pricing"])
				await createNote(seeded, "shared", { title, template: "Decisions" });
			await createNote(seeded, "shared", { title: "Report", body: "Numbers." });
		},
	);
	await screen.findByRole("heading", { name: "Seat pricing" });
	const standing = () =>
		within(screen.getByRole("region", { name: "Standing" }));
	expect(standing().getByText("Active")).toBeDefined();
	fireEvent.click(standing().getByRole("button", { name: "Change status" }));
	const choices = within(
		screen.getByRole("group", { name: "Decision status" }),
	);
	expect(
		(choices.getByRole("radio", { name: /^Active/ }) as HTMLInputElement)
			.checked,
	).toBe(true);
	// Only superseding asks what replaces the decision.
	expect(screen.queryByLabelText("Replaced by")).toBeNull();
	fireEvent.click(choices.getByRole("radio", { name: /^Superseded/ }));
	const save = standing().getByRole("button", { name: "Save status" });
	expect((save as HTMLButtonElement).disabled).toBe(true);
	change("Replaced by", "Report");
	fireEvent.click(save);
	expect((await standing().findByRole("alert")).textContent).toMatch(
		/"Report" is not a decision/,
	);
	change("Replaced by", "Usage pricing");
	change("Reason (optional)", "Simpler for small teams.");
	fireEvent.click(save);
	// The form closes once the status is saved and the note has reloaded.
	await waitFor(() =>
		expect(screen.queryByRole("group", { name: "Decision status" })).toBeNull(),
	);
	expect(standing().getByText("Superseded")).toBeDefined();
	expect(standing().queryByRole("alert")).toBeNull();
	expect(standing().getByText(/^Superseded by/).textContent).toBe(
		"Superseded by Usage pricing",
	);
	const stored = (await readNote(running, "Seat pricing")).json();
	expect(stored.standing).toMatchObject({
		status: "superseded",
		supersededBy: ["Usage pricing"],
		current: false,
	});
	expect(stored.note.body).toMatch(
		/## Status\n- \d{4}-\d{2}-\d{2} Superseded by \[\[Usage pricing\]\] \(Founder\): Simpler for small teams\./,
	);
	// The decision that replaced it says so, and can be disputed in turn.
	fireEvent.click(standing().getByRole("link", { name: "Usage pricing" }));
	await screen.findByRole("heading", { name: "Usage pricing" });
	await waitFor(() =>
		expect(standing().getByText(/^Supersedes/).textContent).toBe(
			"Supersedes Seat pricing",
		),
	);
	fireEvent.click(standing().getByRole("button", { name: "Change status" }));
	fireEvent.click(
		within(screen.getByRole("group", { name: "Decision status" })).getByRole(
			"radio",
			{ name: /^Disputed/ },
		),
	);
	fireEvent.click(standing().getByRole("button", { name: "Save status" }));
	await waitFor(() =>
		expect(screen.queryByRole("group", { name: "Decision status" })).toBeNull(),
	);
	expect(standing().getByText("Disputed")).toBeDefined();
	expect(
		(await readNote(running, "Usage pricing")).json().standing.status,
	).toBe("disputed");
	// A note that is not a decision has no status to change.
	fireEvent.click(
		await within(
			await screen.findByRole("complementary", { name: "Notes" }),
		).findByRole("link", { name: /^Report/ }),
	);
	await screen.findByRole("heading", { name: "Report" });
	expect(screen.queryByRole("region", { name: "Standing" })).toBeNull();
});

it("cites a source on a note, verifies the passage, and says when the source changed", async () => {
	const running = await start(
		"#/synapse/shared/Usage%20pricing",
		async (seeded) => {
			await createNote(seeded, "shared", {
				title: "Report",
				body: "Revenue grew 12%.",
			});
			await createNote(seeded, "shared", {
				title: "Usage pricing",
				template: "Decisions",
			});
		},
	);
	await screen.findByRole("heading", { name: "Usage pricing" });
	const evidence = () =>
		within(screen.getByRole("region", { name: /^Evidence \(\d+\)$/ }));
	expect(evidence().getByText(/This note cites nothing yet/)).toBeDefined();
	fireEvent.click(evidence().getByRole("button", { name: "Cite a source" }));
	const cite = evidence().getByRole("button", { name: "Cite source" });
	expect((cite as HTMLButtonElement).disabled).toBe(true);
	change("Source note", "Report");
	change("Passage", "Revenue fell");
	fireEvent.click(cite);
	expect((await evidence().findByRole("alert")).textContent).toBe(
		'"Report" does not contain that passage. Quote its words exactly.',
	);
	change("Passage", "Revenue grew 12%");
	fireEvent.click(cite);
	const cited = within(await region("Evidence (1)"));
	expect(cited.getByText("Verified")).toBeDefined();
	expect(cited.getByText("Revenue grew 12%")).toBeDefined();
	expect(
		cited.getByText(/^Cited at revision 1 on \d{4}-\d{2}-\d{2}$/),
	).toBeDefined();
	expect(cited.queryByRole("form", { name: "Cite a source" })).toBeNull();
	expect((await readNote(running, "Usage pricing")).json().note.body).toMatch(
		/^## Evidence\n- \[\[Report\]\] \(r1, /,
	);
	// The evidence line is a link, so the source lists this note among its backlinks.
	await editNote(running, "Report", { body: "Revenue shrank." });
	fireEvent.click(cited.getByRole("link", { name: "Report" }));
	await screen.findByRole("heading", { name: "Report" });
	fireEvent.click(
		within(await region("Backlinks (1)")).getByRole("link", {
			name: "Usage pricing",
		}),
	);
	await screen.findByRole("heading", { name: "Usage pricing" });
	await waitFor(() =>
		expect(evidence().getByText("The source changed")).toBeDefined(),
	);
	expect(evidence().queryByText("Verified")).toBeNull();
});

it("lists a note's history, shows a past revision's source, and restores it", async () => {
	const running = await start("#/synapse/shared/Pricing", async (seeded) => {
		await createNote(seeded, "shared", { title: "Pricing", body: "Seats." });
		await editNote(seeded, "Pricing", { body: "Usage." });
	});
	const note = within(await region("Note"));
	await note.findByRole("heading", { name: "Pricing" });
	expect(note.getByText("Usage.")).toBeDefined();
	expect(screen.queryByRole("region", { name: "History" })).toBeNull();
	const toggle = note.getByRole("button", { name: "History" });
	expect(toggle.getAttribute("aria-expanded")).toBe("false");
	fireEvent.click(toggle);
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	const history = within(await region("History"));
	const table = within(
		await history.findByRole("table", {
			name: "Revisions of Pricing, newest first",
		}),
	);
	const rows = () =>
		table
			.getAllByRole("row")
			.slice(1)
			.map((row) =>
				within(row)
					.getAllByRole("cell")
					.slice(0, 2)
					.map((cell) => cell.textContent)
					.concat(
						within(row).getByRole("rowheader").textContent ?? "",
						within(row).getAllByRole("cell")[3].textContent ?? "",
					),
			);
	expect(rows()).toEqual([
		["Updated", "Founder", "2 (current)", "6 characters"],
		["Created", "Founder", "1", "6 characters"],
	]);
	fireEvent.click(history.getByRole("button", { name: "View revision 2" }));
	const current = within(await region(/^Revision 2: updated by Founder/));
	expect(current.getByText(/This is the current revision\./)).toBeDefined();
	// The current revision is already the note: there is nothing to restore.
	expect(
		current.queryByRole("button", { name: "Restore this revision" }),
	).toBeNull();
	fireEvent.click(history.getByRole("button", { name: "View revision 1" }));
	const first = within(await region(/^Revision 1: created by Founder/));
	expect(first.getByText("Seats.").tagName).toBe("PRE");
	fireEvent.click(first.getByRole("button", { name: "Restore this revision" }));
	await history.findByText("Restored revision 1. It is now revision 3.");
	// The note reloads with what the revision held, and the history gains the restore.
	await waitFor(() => expect(rows()).toHaveLength(3));
	expect(rows()[0]).toEqual([
		"Updated",
		"Founder",
		"3 (current)",
		"6 characters",
	]);
	expect(note.getByText("Seats.").tagName).toBe("P");
	expect(note.queryByText("Usage.")).toBeNull();
	expect(note.getByText(/revision 3$/)).toBeDefined();
	expect(screen.queryByRole("region", { name: /^Revision 1/ })).toBeNull();
	expect((await readNote(running, "Pricing")).json().note).toMatchObject({
		body: "Seats.",
		revision: 3,
	});
	fireEvent.click(toggle);
	expect(screen.queryByRole("region", { name: "History" })).toBeNull();
});

it("refuses to restore over an edit made after the history was opened", async () => {
	const running = await start("#/synapse/shared/Plan", async (seeded) => {
		await createNote(seeded, "shared", { title: "Plan", body: "First." });
		await editNote(seeded, "Plan", { body: "Second." });
	});
	const note = within(await region("Note"));
	await note.findByText("Second.");
	fireEvent.click(note.getByRole("button", { name: "History" }));
	const history = within(await region("History"));
	fireEvent.click(
		await history.findByRole("button", { name: "View revision 1" }),
	);
	const first = within(await region(/^Revision 1: created by Founder/));
	// Someone else edits before Restore is pressed.
	await editNote(running, "Plan", { body: "Third, by someone else." });
	fireEvent.click(first.getByRole("button", { name: "Restore this revision" }));
	await history.findByText(/This note changed during your request/);
	// Their edit stands, and the page shows it.
	await note.findByText("Third, by someone else.");
	expect((await readNote(running, "Plan")).json().note).toMatchObject({
		body: "Third, by someone else.",
		revision: 3,
	});
});

it("shows a deleted note's history where the note was, and restores it", async () => {
	await start("#/synapse/shared/Gone", async (seeded) => {
		await createNote(seeded, "shared", {
			title: "Gone",
			body: "Kept in history.",
		});
		const deleted = await seeded.server.inject({
			method: "DELETE",
			url: "/v1/synapse/spaces/shared/notes/Gone",
			headers: seeded.owner,
		});
		expect(deleted.statusCode).toBe(204);
	});
	await screen.findByRole("heading", { name: "No note titled “Gone”" });
	expect(screen.queryByRole("region", { name: "History" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "History" }));
	const history = within(await region("History"));
	fireEvent.click(
		await history.findByRole("button", { name: "View revision 2" }),
	);
	const last = within(await region(/^Revision 2: deleted by Founder/));
	// The last record of a deleted note holds what was deleted.
	expect(last.getByText("Kept in history.").tagName).toBe("PRE");
	fireEvent.click(last.getByRole("button", { name: "Restore this revision" }));
	const note = within(await region("Note"));
	await note.findByRole("heading", { name: "Gone" });
	expect(note.getByText("Kept in history.").tagName).toBe("P");
});

it("keeps Global read-only for members on every tab, and shows the server's refusal to fetch a page for them", async () => {
	const running = await boot({ signIn: false });
	const { server } = running;
	const workspaceId = await defaultWorkspaceId(
		running.url,
		running.owner.authorization.replace(/^Bearer /, ""),
	);
	const added = await server.inject({
		method: "POST",
		url: "/v1/team",
		headers: running.owner,
		payload: {
			email: "member@example.com",
			name: "Member",
			role: "member",
			password: PASSWORD,
			workspace: { workspaceId, role: "member" },
		},
	});
	expect(added.statusCode, added.body).toBe(201);
	await createNote(running, "global", {
		title: "Brand voice",
		template: "Decisions",
		body: "Our brand voice is plain words.",
	});
	const run = await api(running, "POST", "global/maintenance/run");
	expect(run.statusCode, run.body).toBe(200);
	const session = await server.inject({
		method: "POST",
		url: "/v1/auth/session",
		payload: { email: "member@example.com", password: PASSWORD },
	});
	expect(session.statusCode, session.body).toBeLessThan(300);
	setSessionToken(session.json().token);
	renderAt("#/synapse/capture");

	// In the workspace's own space a member saves text, but not a page by its address alone.
	const form = within(await region("Save to Synapse"));
	change("Page address (URL)", "https://example.com/pricing");
	fireEvent.click(form.getByRole("button", { name: "Save to Synapse" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"Only a workspace admin can capture a page by its address alone. Send the page's text along with the url.",
	);
	expect(screen.queryByRole("region", { name: "What was saved" })).toBeNull();

	await pickSpace("global");
	await screen.findByText(/nothing can be\s+saved to it from here/);
	expect(screen.queryByRole("region", { name: "Save to Synapse" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Save to Synapse" })).toBeNull();

	fireEvent.click(tab("Ask"));
	change("Question", "What is our brand voice?");
	fireEvent.click(
		within(await region("Ask")).getByRole("button", { name: "Ask" }),
	);
	const passages = within(await region(/^Passages for/));
	expect(passages.getByRole("link", { name: "Brand voice" })).toBeDefined();
	expect(screen.queryByRole("region", { name: "Save as answer" })).toBeNull();

	fireEvent.click(tab("Commitments"));
	await within(await region("Commitments")).findByText(/No commitments yet/);
	expect(screen.getByText(/You can read its\s+commitments here/)).toBeDefined();
	expect(screen.queryByRole("button", { name: "New commitment" })).toBeNull();

	fireEvent.click(tab("Maintenance"));
	const unsupported = within(await region("Unsupported claims (1)"));
	expect(unsupported.getByRole("link", { name: "Brand voice" })).toBeDefined();
	expect(unsupported.queryByRole("checkbox")).toBeNull();
	expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
	expect(
		screen.queryByRole("group", { name: "Review several findings" }),
	).toBeNull();

	// On the note, a member reads the standing and the history, and changes neither.
	fireEvent.click(unsupported.getByRole("link", { name: "Brand voice" }));
	await screen.findByRole("heading", { name: "Brand voice" });
	expectHash("synapse/global/Brand%20voice");
	const standing = within(await region("Standing"));
	expect(standing.getByText("Active")).toBeDefined();
	expect(standing.queryByRole("button", { name: "Change status" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Cite a source" })).toBeNull();
	expect(screen.queryByRole("region", { name: /^Evidence/ })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "History" }));
	const history = within(await region("History"));
	fireEvent.click(
		await history.findByRole("button", { name: "View revision 1" }),
	);
	const first = within(await region(/^Revision 1: created by Founder/));
	expect(first.getByText(/Our brand voice is plain words\./)).toBeDefined();
	expect(
		first.queryByRole("button", { name: "Restore this revision" }),
	).toBeNull();
});
