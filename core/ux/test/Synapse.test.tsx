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
import { clearCredential, setSessionToken } from "../src/api.js";
import {
	defaultWorkspaceId,
	PASSWORD,
	routeToWorkspace,
	setUpOwner,
	stopServer,
} from "./session.js";

// Synapse dashboard runs against a real gateway API server (no fetch
// mocks): each test boots @autonomo.us/server on an ephemeral port, completes
// setup as the owner, and drives the React app with Testing Library.

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
async function boot(): Promise<Running> {
	const server = createServer({
		config: { providers: [], corsOrigins: ["*"] },
		logger: false,
	});
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	closers.push(() => stopServer(server));
	vi.stubEnv("VITE_API_URL", url);
	const token = await setUpOwner(url);
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
async function start(hash = "#/synapse") {
	const running = await boot();
	renderAt(hash);
	return running;
}
/** Synapse URLs sit inside the selected workspace: #/w/<id>/synapse/... */
const expectHash = (path: string) =>
	expect(window.location.hash).toBe(
		`#/w/${window.location.hash.split("/")[2]}/${path}`,
	);
const change = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
const noteRegion = () => screen.getByRole("region", { name: "Note" });
/**
 * Picks a space once the list of spaces has it, as a person would. Before
 * the list loads, the select offers only the current space, and picking an
 * option it does not have yet would choose none.
 */
const pickSpace = async (id: string) => {
	const select = screen.getByLabelText("Space") as HTMLSelectElement;
	await waitFor(
		() =>
			expect(Array.from(select.options, (option) => option.value)).toContain(
				id,
			),
		{ timeout: 3000 },
	);
	fireEvent.change(select, { target: { value: id } });
};
const graphRegion = () => screen.getByRole("region", { name: "Graph" });
/** The graph's drawing; its name counts the notes and links it shows. */
const graphCanvas = async (name: string | RegExp = /^Graph of/) =>
	within(await screen.findByRole("region", { name: "Graph" })).findByRole(
		"group",
		{ name },
	);
const notesList = () => screen.findByRole("complementary", { name: "Notes" });
const properties = () => screen.getByRole("table", { name: "Properties" });
const today = () => new Date().toISOString().slice(0, 10);

async function createNote(
	{ server, owner }: Running,
	space: string,
	payload: Record<string, unknown>,
) {
	const response = await server.inject({
		method: "POST",
		url: `/v1/synapse/spaces/${space}/notes`,
		headers: owner,
		payload,
	});
	expect(response.statusCode, response.body).toBe(201);
	return response.json();
}
async function readNote(
	{ server, owner }: Running,
	space: string,
	title: string,
) {
	return server.inject({
		url: `/v1/synapse/spaces/${space}/notes/${encodeURIComponent(title)}`,
		headers: owner,
	});
}
async function createAgent({ server, url, owner }: Running) {
	// Agent tokens belong to a workspace; Synapse itself is gateway-wide.
	const workspace = await defaultWorkspaceId(
		url,
		owner.authorization.replace(/^Bearer /, ""),
	);
	const response = await server.inject({
		method: "POST",
		url: `/v1/${workspace}/agent-tokens`,
		headers: owner,
		payload: {
			name: "Research agent",
			description: "Files proposals",
			ttlDays: "never",
			permissions: ["mcp:read", "mcp:call"],
		},
	});
	expect(response.statusCode, response.body).toBe(201);
	return response.json() as { token: { id: string }; secret: string };
}
/** Calls a Synapse tool the way an agent does: JSON-RPC over the MCP endpoint. */
async function mcpCall(
	url: string,
	secret: string,
	name: string,
	args: Record<string, unknown>,
) {
	const response = await fetch(`${url}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${secret}`,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	const body = await response.json();
	if (body.error || body.result?.isError)
		throw new Error(`${name} failed: ${JSON.stringify(body)}`);
	return body.result;
}

it("navigates to Synapse and creates a note from a template with its properties", async () => {
	await start();
	await screen.findByText(/No notes yet/);
	expect(
		screen.getByRole("link", { name: "Synapse" }).getAttribute("aria-current"),
	).toBe("page");
	// The space list is a separate request from the notes list.
	await screen.findByText(/Notes are temporary until MongoDB/);
	expect(
		within(screen.getByLabelText("Space"))
			.getAllByRole("option")
			.map((option) => option.textContent),
	).toEqual(["Global (0 notes)", "Shared (0 notes, inherits Global)"]);
	fireEvent.click(screen.getByRole("button", { name: "New note" }));
	change("Title", "Ada Lovelace");
	await screen.findByRole("option", { name: "People" });
	change("Template", "People");
	expect(screen.getByText(/Properties: .*role.*created/)).toBeDefined();
	fireEvent.click(screen.getByRole("button", { name: "Create note" }));
	await screen.findByRole("heading", { name: "Ada Lovelace" });
	expectHash("synapse/shared/Ada%20Lovelace");
	const table = within(properties());
	const keys = table.getAllByRole("rowheader").map((cell) => cell.textContent);
	expect(keys).toHaveLength(6);
	expect(keys).toEqual(
		expect.arrayContaining([
			"categories",
			"org",
			"role",
			"email",
			"url",
			"created",
		]),
	);
	expect(table.getByRole("link", { name: "People" })).toBeDefined();
	expect(table.getByText(today())).toBeDefined();
	expect(screen.getByText(/This note has no body yet/)).toBeDefined();
	// The template's category note was created automatically and lists its members.
	await within(await notesList()).findByRole("link", { name: /^People/ });
	expect(within(await notesList()).getByText("2 notes")).toBeDefined();
	fireEvent.click(table.getByRole("link", { name: "People" }));
	await screen.findByRole("heading", { name: "People" });
	expectHash("synapse/shared/People");
	const members = within(
		await screen.findByRole("region", { name: /^Notes in People/ }),
	);
	expect(members.getByRole("link", { name: "Ada Lovelace" })).toBeDefined();
	expect(
		within(screen.getByRole("region", { name: /^Backlinks/ })).getByRole(
			"link",
			{
				name: "Ada Lovelace",
			},
		),
	).toBeDefined();
	// The category note itself shows the built-in description and the chip for its tag.
	expect(within(noteRegion()).getByText("#categories")).toBeDefined();
});

it("edits Markdown, shows unresolved links as breadcrumbs, and resolves them when the note is created", async () => {
	const running = await start();
	await createNote(running, "shared", {
		title: "Ada Lovelace",
		body: "First programmer.",
	});
	fireEvent.click(
		await within(await notesList()).findByRole("link", {
			name: /^Ada Lovelace/,
		}),
	);
	await screen.findByRole("heading", { name: "Ada Lovelace" });
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	const editor = screen.getByLabelText(
		"Markdown source",
	) as HTMLTextAreaElement;
	expect(editor.value).toContain("First programmer.");
	change(
		"Markdown source",
		[
			"---",
			"categories:",
			'  - "[[People]]"',
			"role: Mathematician",
			"---",
			"## Work",
			"",
			"Worked with [[Charles Babbage|Babbage]] on the **engine**. See [docs](https://example.com/x) and [bad](javascript:alert(1)).",
			"",
			"- item `code`",
			"- [ ] open task",
			"",
			"```",
			"[[Not a link]]",
			"```",
		].join("\n"),
	);
	fireEvent.click(screen.getByRole("button", { name: "Save note" }));
	const link = await screen.findByRole("link", { name: "Babbage" });
	expect(link.className).toContain("unresolved");
	// Page h1, note title h2, so the body's ## is h4.
	expect(screen.getByRole("heading", { name: "Work" }).tagName).toBe("H4");
	expect(screen.getByText("engine").tagName).toBe("STRONG");
	expect(screen.getByText("code").tagName).toBe("CODE");
	expect(screen.getByRole("checkbox", { name: "Open task" })).toBeDefined();
	expect(screen.getByRole("link", { name: "docs" }).getAttribute("rel")).toBe(
		"noreferrer",
	);
	expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
	expect(screen.queryByRole("link", { name: "Not a link" })).toBeNull();
	expect(within(properties()).getByText("Mathematician")).toBeDefined();
	const unresolved = within(
		screen.getByRole("region", { name: "Unresolved links (1)" }),
	);
	fireEvent.click(
		unresolved.getByRole("button", { name: "Create note Charles Babbage" }),
	);
	expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
		"Charles Babbage",
	);
	fireEvent.click(screen.getByRole("button", { name: "Create note" }));
	await screen.findByRole("heading", { name: "Charles Babbage" });
	const backlinks = within(
		await screen.findByRole("region", { name: "Backlinks (1)" }),
	);
	fireEvent.click(backlinks.getByRole("link", { name: "Ada Lovelace" }));
	await screen.findByRole("heading", { name: "Ada Lovelace" });
	await waitFor(() =>
		expect(
			screen.getByRole("link", { name: "Babbage" }).className,
		).not.toContain("unresolved"),
	);
	expect(
		screen.getByRole("region", { name: "Unresolved links (0)" }),
	).toBeDefined();
	// Following a wikilink in the body navigates.
	fireEvent.click(screen.getByRole("link", { name: "Babbage" }));
	await screen.findByRole("heading", { name: "Charles Babbage" });
	expectHash("synapse/shared/Charles%20Babbage");
	const stored = (await readNote(running, "shared", "Ada Lovelace")).json();
	expect([...stored.note.links].sort()).toEqual(["Charles Babbage", "People"]);
	expect(stored.note.categories).toEqual(["People"]);
});

it("reports a save conflict and lets the editor reload", async () => {
	const running = await start();
	await createNote(running, "shared", { title: "Roadmap", body: "v1" });
	fireEvent.click(
		await within(await notesList()).findByRole("link", { name: /^Roadmap/ }),
	);
	await screen.findByRole("heading", { name: "Roadmap" });
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	// Someone else saves first.
	const patched = await running.server.inject({
		method: "PATCH",
		url: "/v1/synapse/spaces/shared/notes/Roadmap",
		headers: running.owner,
		payload: { body: "v1 shipped" },
	});
	expect(patched.statusCode, patched.body).toBe(200);
	change("Markdown source", "v2 draft");
	fireEvent.click(screen.getByRole("button", { name: "Save note" }));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("changed since you opened it");
	fireEvent.click(within(alert).getByRole("button", { name: "Reload note" }));
	await screen.findByText(/revision 2$/);
	expect(screen.queryByRole("alert")).toBeNull();
	await waitFor(() =>
		expect(
			(screen.getByRole("button", { name: "Save note" }) as HTMLButtonElement)
				.disabled,
		).toBe(false),
	);
	expect(
		(screen.getByLabelText("Markdown source") as HTMLTextAreaElement).value,
	).toBe("v2 draft");
	fireEvent.click(screen.getByRole("button", { name: "Save note" }));
	await screen.findByText("v2 draft", { selector: "p" });
	expect((await readNote(running, "shared", "Roadmap")).json().note.body).toBe(
		"v2 draft",
	);
});

it("keeps an open draft when the space refreshes, and still detects conflicts", async () => {
	const running = await start();
	await createNote(running, "shared", { title: "Roadmap", body: "v1" });
	fireEvent.click(
		await within(await notesList()).findByRole("link", { name: /^Roadmap/ }),
	);
	await screen.findByRole("heading", { name: "Roadmap" });
	fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	change("Markdown source", "v2 draft");
	// An import elsewhere refreshes the space while the editor is open.
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	fireEvent.change(screen.getByLabelText("Markdown files"), {
		target: { files: [new File(["Other body."], "Other.md")] },
	});
	await screen.findByText(/1 Markdown file/);
	fireEvent.click(
		within(
			screen.getByRole("region", { name: "Import into the shared space" }),
		).getByRole("button", { name: "Import" }),
	);
	await screen.findByText("Imported: 1 created, 0 updated, 0 skipped.");
	await within(await notesList()).findByText("2 notes");
	const source = screen.getByLabelText(
		"Markdown source",
	) as HTMLTextAreaElement;
	expect(source.value).toBe("v2 draft");
	expect(document.activeElement?.id).not.toBe("synapse-note-title");
	// A change made meanwhile is still a conflict, not an overwrite.
	const patched = await running.server.inject({
		method: "PATCH",
		url: "/v1/synapse/spaces/shared/notes/Roadmap",
		headers: running.owner,
		payload: { body: "v1 shipped" },
	});
	expect(patched.statusCode, patched.body).toBe(200);
	// The import form is still open from the first round.
	fireEvent.change(screen.getByLabelText("Markdown files"), {
		target: { files: [new File(["Third."], "Third.md")] },
	});
	await screen.findByText(/1 Markdown file/);
	fireEvent.click(
		within(
			screen.getByRole("region", { name: "Import into the shared space" }),
		).getByRole("button", { name: "Import" }),
	);
	await within(await notesList()).findByText("3 notes");
	fireEvent.click(screen.getByRole("button", { name: "Save note" }));
	expect((await screen.findByRole("alert")).textContent).toContain(
		"changed since you opened it",
	);
	expect((await readNote(running, "shared", "Roadmap")).json().note.body).toBe(
		"v1 shipped",
	);
});

it("refuses a stale delete confirmation instead of deleting a newer revision", async () => {
	const running = await start();
	await createNote(running, "shared", { title: "Roadmap", body: "v1" });
	fireEvent.click(
		await within(await notesList()).findByRole("link", { name: /^Roadmap/ }),
	);
	await screen.findByRole("heading", { name: "Roadmap" });
	fireEvent.click(screen.getByRole("button", { name: "Delete" }));
	// Someone edits the note while the confirmation is open.
	const patched = await running.server.inject({
		method: "PATCH",
		url: "/v1/synapse/spaces/shared/notes/Roadmap",
		headers: running.owner,
		payload: { body: "v2 from a teammate" },
	});
	expect(patched.statusCode, patched.body).toBe(200);
	fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("then confirm again");
	expect((await readNote(running, "shared", "Roadmap")).statusCode).toBe(200);
	fireEvent.click(within(alert).getByRole("button", { name: "Reload note" }));
	await screen.findByText(/revision 2$/);
	fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
	await screen.findByText("Deleted “Roadmap”.");
	expect((await readNote(running, "shared", "Roadmap")).statusCode).toBe(404);
});

it("imports a vault past one request's limit and says when the list is capped", async () => {
	await start();
	await screen.findByText(/No notes yet/);
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	fireEvent.change(screen.getByLabelText("Markdown files"), {
		target: {
			files: Array.from(
				{ length: 501 },
				(_, index) => new File([`Body ${index}`], `Note ${index}.md`),
			),
		},
	});
	await screen.findByText(/501 Markdown files/);
	fireEvent.click(
		within(
			screen.getByRole("region", { name: "Import into the shared space" }),
		).getByRole("button", { name: "Import" }),
	);
	await screen.findByText(
		"Imported: 501 created, 0 updated, 0 skipped.",
		undefined,
		{
			timeout: 10_000,
		},
	);
	await within(await notesList()).findByText(
		/501 notes · showing the first 200; search or filter to narrow/,
	);
});

it("moves between Synapse tabs with the arrow keys and keeps field ids unique", async () => {
	const running = await start();
	await createNote(running, "shared", { title: "Roadmap", body: "v1" });
	const notesTab = await screen.findByRole("tab", { name: "Notes" });
	expect(notesTab.getAttribute("aria-controls")).toBe("synapse-panel");
	expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
		"synapse-tab-notes",
	);
	notesTab.focus();
	fireEvent.keyDown(notesTab, { key: "ArrowRight" });
	const proposalsTab = screen.getByRole("tab", { name: "Proposals" });
	await waitFor(() =>
		expect(proposalsTab.getAttribute("aria-selected")).toBe("true"),
	);
	expect(document.activeElement).toBe(proposalsTab);
	expect(proposalsTab.tabIndex).toBe(0);
	expect(screen.getByRole("tab", { name: "Notes" }).tabIndex).toBe(-1);
	fireEvent.keyDown(proposalsTab, { key: "Home" });
	await waitFor(() =>
		expect(
			screen.getByRole("tab", { name: "Notes" }).getAttribute("aria-selected"),
		).toBe("true"),
	);
	// The rename field and the New note title can be open together.
	fireEvent.click(
		await within(await notesList()).findByRole("link", { name: /^Roadmap/ }),
	);
	await screen.findByRole("heading", { name: "Roadmap" });
	fireEvent.click(screen.getByRole("button", { name: "Rename" }));
	fireEvent.click(screen.getByRole("button", { name: "New note" }));
	expect(document.querySelectorAll("#synapse-new-title")).toHaveLength(1);
	expect((screen.getByLabelText("New title") as HTMLInputElement).value).toBe(
		"Roadmap",
	);
});

it("searches, filters by category, renames with link rewriting, and deletes", async () => {
	const running = await boot();
	await createNote(running, "shared", {
		title: "Ada Lovelace",
		template: "People",
		body: "Wrote the first program.",
	});
	await createNote(running, "shared", {
		title: "Grace Hopper",
		template: "People",
		body: "COBOL pioneer.",
	});
	await createNote(running, "shared", {
		title: "Analytical Engine",
		template: "Projects",
		body: "Designed with [[Ada Lovelace]].",
	});
	renderAt("#/synapse");
	const list = within(await notesList());
	await list.findByText("5 notes");
	change("Search notes", "cobol");
	await list.findByText("1 note match");
	expect(list.getByRole("link", { name: /^Grace Hopper/ })).toBeDefined();
	expect(list.getByText("COBOL pioneer.")).toBeDefined();
	expect(list.queryByRole("link", { name: /^Ada Lovelace/ })).toBeNull();
	change("Search notes", "");
	await list.findByText("5 notes");
	// Categories load separately from the notes list.
	await waitFor(() =>
		expect(
			within(screen.getByLabelText("Category"))
				.getAllByRole("option")
				.map((option) => option.textContent)
				.sort(),
		).toEqual(["All categories", "People (2)", "Projects (1)"]),
	);
	change("Category", "People");
	await list.findByText("2 notes match");
	expect(list.getByRole("link", { name: /^Ada Lovelace/ })).toBeDefined();
	expect(list.getByRole("link", { name: /^Grace Hopper/ })).toBeDefined();
	expect(list.queryByRole("link", { name: /^Analytical Engine/ })).toBeNull();
	fireEvent.click(list.getByRole("link", { name: /^Ada Lovelace/ }));
	await screen.findByRole("heading", { name: "Ada Lovelace" });
	expect(
		list
			.getByRole("link", { name: /^Ada Lovelace/ })
			.getAttribute("aria-current"),
	).toBe("page");
	fireEvent.click(screen.getByRole("button", { name: "Rename" }));
	change("New title", "Ada King");
	fireEvent.click(screen.getByRole("button", { name: "Rename note" }));
	await screen.findByRole("heading", { name: "Ada King" });
	expectHash("synapse/shared/Ada%20King");
	await list.findByRole("link", { name: /^Ada King/ });
	expect(
		(await readNote(running, "shared", "Analytical Engine")).json().note.body,
	).toBe("Designed with [[Ada King]].");
	fireEvent.click(screen.getByRole("button", { name: "Delete" }));
	fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
	await screen.findByText("Deleted “Ada King”.");
	await list.findByText("1 note match");
	expect(list.queryByRole("link", { name: /^Ada King/ })).toBeNull();
	// Back on the graph, where the deleted note is now an unresolved link.
	await within(graphRegion()).findByRole("button", {
		name: "Create note Ada King",
	});
	expectHash("synapse/shared");
	expect((await readNote(running, "shared", "Ada King")).statusCode).toBe(404);
	// The deleted note's title is now a breadcrumb from the project note.
	change("Category", "");
	fireEvent.click(
		await list.findByRole("link", { name: /^Analytical Engine/ }),
	);
	await screen.findByRole("region", { name: "Unresolved links (1)" });
	expect(screen.getByRole("link", { name: "Ada King" }).className).toContain(
		"unresolved",
	);
});

it("lets owners approve and reject agent proposals, surfacing conflicts", async () => {
	const running = await start();
	const { server, url, owner } = running;
	const agent = await createAgent(running);
	await createNote(running, "shared", {
		title: "Brand voice",
		body: "Warm and precise.",
	});
	// The agent's first write names its space after the token.
	await mcpCall(url, agent.secret, "synapse_log", {
		text: "Reviewed the release notes.",
	});
	await mcpCall(url, agent.secret, "synapse_propose", {
		action: "create",
		title: "Release checklist",
		body: "- Tag the build",
		properties: { categories: ["[[Projects]]"] },
		reason: "We repeat this every release.",
	});
	await mcpCall(url, agent.secret, "synapse_propose", {
		action: "append",
		title: "Brand voice",
		text: "No exclamation marks.",
		reason: "Agreed in the meeting.",
	});
	await within(await notesList()).findByText("1 note");
	fireEvent.click(screen.getByRole("tab", { name: "Proposals" }));
	expectHash("synapse/proposals");
	const create = within(
		await screen.findByRole("article", { name: "Create Release checklist" }),
	);
	expect(create.getByText(/We repeat this every release/)).toBeDefined();
	expect(create.getByText("Research agent", { exact: false })).toBeDefined();
	await create.findByText("(No note yet.)");
	expect(create.getByText(/- Tag the build/)).toBeDefined();
	const append = within(
		screen.getByRole("article", { name: "Append to Brand voice" }),
	);
	await append.findByText(/Warm and precise\./);
	expect(append.getByText("No exclamation marks.")).toBeDefined();
	fireEvent.click(
		create.getByRole("button", { name: "Approve Release checklist" }),
	);
	await screen.findByText(/Approved: create “Release checklist”/);
	expect(
		(await readNote(running, "shared", "Release checklist")).statusCode,
	).toBe(200);
	await waitFor(() =>
		expect(
			screen.queryByRole("article", { name: "Create Release checklist" }),
		).toBeNull(),
	);
	// The shared note moves on before the append is reviewed: approval conflicts.
	const patched = await server.inject({
		method: "PATCH",
		url: "/v1/synapse/spaces/shared/notes/Brand%20voice",
		headers: owner,
		payload: { body: "Warm, precise, and short." },
	});
	expect(patched.statusCode, patched.body).toBe(200);
	fireEvent.click(append.getByRole("button", { name: "Approve Brand voice" }));
	expect((await append.findByRole("alert")).textContent).toMatch(
		/revision|changed/i,
	);
	expect(
		screen.getByRole("article", { name: "Append to Brand voice" }),
	).toBeDefined();
	fireEvent.click(append.getByRole("button", { name: "Reject Brand voice" }));
	expect(
		(
			append.getByRole("button", {
				name: "Confirm rejection",
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
	fireEvent.change(append.getByLabelText("Rejection reason"), {
		target: { value: "The note was rewritten; propose against the new text." },
	});
	fireEvent.click(append.getByRole("button", { name: "Confirm rejection" }));
	await screen.findByText(/Rejected: append to “Brand voice”/);
	await screen.findByText(/No pending proposals/);
	const proposals = (
		await server.inject({ url: "/v1/synapse/proposals", headers: owner })
	).json();
	expect(
		proposals.proposals.map((item: { title: string; status: string }) => [
			item.title,
			item.status,
		]),
	).toEqual([
		["Brand voice", "rejected"],
		["Release checklist", "approved"],
	]);
	// The rejection reason flowed back into the agent's daily note.
	const daily = await readNote(running, `agent-${agent.token.id}`, today());
	expect(daily.statusCode, daily.body).toBe(200);
	expect(daily.json().note.body).toContain(
		"rejected by Founder: The note was rewritten",
	);
	// The agent's space now shows up in the picker.
	fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
	await waitFor(() =>
		expect(
			within(screen.getByLabelText("Space"))
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual([
			"Global (0 notes)",
			"Shared (3 notes, inherits Global)",
			"Research agent (1 note)",
		]),
	);
	change("Space", `agent-${agent.token.id}`);
	expectHash(`synapse/agent-${agent.token.id}`);
	fireEvent.click(
		await within(await notesList()).findByRole("link", {
			name: new RegExp(`^${today()}`),
		}),
	);
	await screen.findByRole("heading", { name: today() });
	expect(screen.getByRole("heading", { name: "Log" })).toBeDefined();
});

it("shows members the proposals read-only", async () => {
	const server = createServer({
		config: { providers: [], corsOrigins: ["*"] },
		logger: false,
	});
	const url = await server.listen({ host: "127.0.0.1", port: 0 });
	closers.push(() => stopServer(server));
	vi.stubEnv("VITE_API_URL", url);
	const ownerToken = await setUpOwner(url, { signIn: false });
	const workspaceId = await defaultWorkspaceId(url, ownerToken);
	routeToWorkspace(server, workspaceId);
	const running: Running = {
		server,
		url,
		owner: { authorization: `Bearer ${ownerToken}` },
	};
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
		title: "Canon",
		body: "See [[Missing]].",
	});
	const agent = await createAgent(running);
	await mcpCall(url, agent.secret, "synapse_propose", {
		action: "create",
		title: "Style guide",
		body: "Short sentences.",
		reason: "Everyone asks.",
	});
	const session = await server.inject({
		method: "POST",
		url: "/v1/auth/session",
		payload: { email: "member@example.com", password: PASSWORD },
	});
	expect(session.statusCode, session.body).toBeLessThan(300);
	setSessionToken(session.json().token);
	renderAt("#/synapse/proposals");
	await screen.findByRole("article", { name: "Create Style guide" });
	expect(
		screen.getByText(
			"Workspace admins decide proposals. You can read them here.",
		),
	).toBeDefined();
	expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
	expect(screen.queryByRole("button", { name: /^Reject/ })).toBeNull();
	// Members still read and write spaces from the dashboard.
	fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
	expect(screen.getByRole("button", { name: "New note" })).toBeDefined();
	// Global is read-only for members.
	fireEvent.change(await screen.findByLabelText("Space"), {
		target: { value: "global" },
	});
	await screen.findByText(/owners and admins change it/);
	expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
	// Its graph shows unresolved links, but a member cannot create them.
	const canvas = within(await graphCanvas("Graph of 1 note and 1 link"));
	expect(canvas.getByRole("link", { name: "Canon" })).toBeDefined();
	expect(canvas.queryByRole("button")).toBeNull();
	fireEvent.click(canvas.getByText("Missing"));
	expect(screen.queryByLabelText("Title")).toBeNull();
	fireEvent.change(screen.getByLabelText("Space"), {
		target: { value: "shared" },
	});
	await screen.findByRole("button", { name: "New note" });
	expect(screen.getByRole("link", { name: "Synapse" })).toBeDefined();
	expect(screen.queryByRole("link", { name: "API Tokens" })).toBeNull();
});

it("shows global notes in Shared as read-only until the workspace overrides them", async () => {
	const running = await start();
	await createNote(running, "global", {
		title: "Brand voice",
		body: "Plain words.",
	});
	const list = within(await notesList());
	const link = await list.findByRole("link", { name: /^Brand voice/ });
	expect(within(link).getByText("Global")).toBeDefined();
	fireEvent.click(link);
	await screen.findByRole("heading", { name: "Brand voice" });
	expect(
		screen.getByText(
			/Inherited from the global Synapse, so it is read-only here/,
		),
	).toBeDefined();
	expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
	// Overriding creates the workspace's own note with the same title.
	fireEvent.click(
		screen.getByRole("button", { name: "Override in this workspace" }),
	);
	expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
		"Brand voice",
	);
	fireEvent.click(screen.getByRole("button", { name: "Create note" }));
	await screen.findByText(/This note has no body yet/);
	expect(screen.queryByText(/Inherited from the global Synapse/)).toBeNull();
	expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
	// Global keeps its note, and owners can edit it there.
	fireEvent.change(screen.getByLabelText("Space"), {
		target: { value: "global" },
	});
	fireEvent.click(
		await within(await notesList()).findByRole("link", {
			name: /^Brand voice/,
		}),
	);
	// The list's snippet shows the body too, so wait for the note's own actions.
	expect(await screen.findByRole("button", { name: "Edit" })).toBeDefined();
	expect(screen.queryByText(/Inherited from the global Synapse/)).toBeNull();
	expectHash("synapse/global/Brand%20voice");
});

it("imports Markdown files and a vault folder, then exports the space as a zip", async () => {
	const running = await start();
	await screen.findByText(/No notes yet/);
	fireEvent.click(screen.getByRole("button", { name: "Import" }));
	const form = () =>
		within(
			screen.getByRole("region", { name: "Import into the shared space" }),
		);
	const ada = new File(
		[
			'---\ncategories:\n  - "[[People]]"\nrole: Mathematician\n---\nFirst programmer; see [[Charles Babbage]].',
		],
		"Ada Lovelace.md",
		{ type: "text/markdown" },
	);
	fireEvent.change(screen.getByLabelText("Markdown files"), {
		target: {
			files: [
				ada,
				new File(["Plain body."], "Notes.md"),
				new File(["x"], "photo.png"),
			],
		},
	});
	await screen.findByText(
		"2 Markdown files selected (1 other files will be skipped).",
	);
	// A folder picker reports paths from the chosen folder down; that folder is not part of the space.
	const folderFile = (path: string, content: string) => {
		const file = new File([content], path.split("/").at(-1) ?? path);
		Object.defineProperty(file, "webkitRelativePath", { value: path });
		return file;
	};
	fireEvent.change(screen.getByLabelText("Vault folder"), {
		target: {
			files: [
				folderFile("My Vault/References/Charles Babbage.md", "Engines."),
				folderFile("My Vault/Templates/People Template.md", "{{date}}"),
			],
		},
	});
	await screen.findByText(
		"4 Markdown files selected (1 other files will be skipped).",
	);
	fireEvent.click(form().getByRole("button", { name: "Import" }));
	await screen.findByText("Imported: 3 created, 0 updated, 1 skipped.");
	expect(screen.getByText("Templates/People Template.md")).toBeDefined();
	const list = within(await notesList());
	await list.findByText("4 notes");
	for (const title of ["Ada Lovelace", "Notes", "Charles Babbage", "People"])
		expect(
			list.getByRole("link", { name: new RegExp(`^${title}`) }),
		).toBeDefined();
	// Existing titles are skipped unless overwrite is on.
	fireEvent.change(screen.getByLabelText("Markdown files"), {
		target: { files: [new File(["Updated body."], "Ada Lovelace.md")] },
	});
	fireEvent.click(form().getByRole("button", { name: "Import" }));
	await screen.findByText("Imported: 0 created, 0 updated, 1 skipped.");
	fireEvent.change(screen.getByLabelText("Markdown files"), {
		target: { files: [new File(["Updated body."], "Ada Lovelace.md")] },
	});
	fireEvent.click(screen.getByLabelText("Overwrite existing notes"));
	fireEvent.click(form().getByRole("button", { name: "Import" }));
	await screen.findByText("Imported: 0 created, 1 updated, 0 skipped.");
	expect(
		(await readNote(running, "shared", "Ada Lovelace")).json().note.body,
	).toBe("Updated body.");
	fireEvent.click(form().getByRole("button", { name: "Done" }));

	// Export downloads <space>.zip through an object URL with the session credential.
	const blobs: Blob[] = [];
	const downloads: Array<{ href: string; download: string }> = [];
	const urlApi = URL as unknown as Record<string, unknown>;
	urlApi.createObjectURL = vi.fn((blob: Blob) => {
		blobs.push(blob);
		return "blob:test";
	});
	urlApi.revokeObjectURL = vi.fn();
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		downloads.push({ href: this.href, download: this.download });
	});
	fireEvent.click(screen.getByRole("button", { name: "Export .zip" }));
	await screen.findByText(/Exported shared\.zip/);
	expect(downloads).toEqual([{ href: "blob:test", download: "shared.zip" }]);
	expect(blobs).toHaveLength(1);
	const bytes = new Uint8Array(await blobs[0].arrayBuffer());
	expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");
	const listing = new TextDecoder().decode(bytes);
	expect(listing).toContain("Categories/People.md");
	expect(listing).toContain("Templates/People Template.md");
	delete urlApi.createObjectURL;
	delete urlApi.revokeObjectURL;
});

it("lands on the graph of the space, highlights neighbours, and opens notes from it", async () => {
	const running = await boot();
	await createNote(running, "shared", {
		title: "Analytical Engine",
		body: "Designed with [[Ada Lovelace]] and [[ada lovelace]]; see [[Difference Engine]].",
	});
	await createNote(running, "shared", {
		title: "Ada Lovelace",
		template: "People",
		body: "Wrote about the [[Analytical Engine]].",
	});
	await createNote(running, "shared", { title: "Loner", body: "" });
	renderAt("#/synapse");
	// Four notes (People was created for the category) and one unresolved link.
	const canvas = await graphCanvas("Graph of 4 notes and 3 links");
	const graph = within(canvas);
	const node = (name: string) => graph.getByRole("link", { name });
	// The space's hint keeps the time zone dates use.
	expect(
		await screen.findByText(/Dates and daily notes use UTC\./),
	).toBeDefined();
	expect(
		graph.getAllByRole("link").map((link) => link.getAttribute("aria-label")),
	).toEqual(["Ada Lovelace", "Analytical Engine", "Loner", "People"]);
	expect(node("Ada Lovelace").getAttribute("href")).toBe(
		`${window.location.hash}/shared/Ada%20Lovelace`,
	);
	// Every node has been placed, and the two ends of a link are apart.
	await waitFor(() =>
		expect(node("Ada Lovelace").getAttribute("transform")).not.toBe(
			node("Analytical Engine").getAttribute("transform"),
		),
	);
	expect(canvas.querySelectorAll("[data-index]:not([transform])")).toHaveLength(
		0,
	);
	// Better-linked notes are drawn bigger.
	const radius = (name: string) =>
		Number(node(name).querySelector("circle")?.getAttribute("r"));
	expect(radius("Ada Lovelace")).toBeGreaterThan(radius("Loner"));
	// Categories and unresolved links are drawn differently and explained.
	expect(node("People").classList.contains("category")).toBe(true);
	expect(node("Ada Lovelace").classList.contains("category")).toBe(false);
	const ghost = graph.getByRole("button", {
		name: "Create note Difference Engine",
	});
	expect(ghost.classList.contains("unresolved")).toBe(true);
	expect(
		within(screen.getByRole("list", { name: "Legend" }))
			.getAllByRole("listitem")
			.map((item) => item.textContent),
	).toEqual(["Note", "Category", "Unresolved link"]);

	// Hovering or focusing a note highlights it, its neighbours, and their links.
	const near = () =>
		Array.from(
			canvas.querySelectorAll("[data-index].near"),
			(item) => item.querySelector("text")?.textContent,
		);
	expect(canvas.hasAttribute("data-active")).toBe(false);
	fireEvent.pointerOver(node("Ada Lovelace"));
	expect(canvas.hasAttribute("data-active")).toBe(true);
	expect(near()).toEqual(["Ada Lovelace", "Analytical Engine", "People"]);
	expect(canvas.querySelectorAll("line")).toHaveLength(3);
	expect(canvas.querySelectorAll("line.near")).toHaveLength(2);
	fireEvent.pointerLeave(canvas);
	expect(canvas.hasAttribute("data-active")).toBe(false);
	expect(near()).toEqual([]);
	fireEvent.focus(node("Loner"));
	expect(near()).toEqual(["Loner"]);
	fireEvent.blur(node("Loner"));
	expect(near()).toEqual([]);

	// The buttons zoom about the centre and fit the graph back into view.
	const viewport = canvas.querySelector(
		".synapse-graph-viewport",
	) as SVGGElement;
	const scale = () =>
		Number(
			/scale\(([\d.]+)\)/.exec(viewport.getAttribute("transform") ?? "")?.[1],
		);
	fireEvent.click(screen.getByRole("button", { name: "Fit graph to view" }));
	const fitted = scale();
	fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
	expect(scale()).toBeGreaterThan(fitted);
	fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
	fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
	expect(scale()).toBeLessThan(fitted);
	fireEvent.click(screen.getByRole("button", { name: "Fit graph to view" }));
	expect(scale()).toBe(fitted);

	// Hiding unresolved links removes the node and its link, and the notes
	// that linked to it are counted without it.
	const described = (name: string) =>
		within(screen.getByRole("group", { name: /^Graph of/ }))
			.getByRole("link", { name })
			.querySelector("title")?.textContent;
	expect(described("Analytical Engine")).toBe("Analytical Engine · 2 links");
	fireEvent.click(screen.getByRole("checkbox", { name: "Show unresolved" }));
	await graphCanvas("Graph of 4 notes and 2 links");
	expect(
		screen.queryByRole("button", { name: "Create note Difference Engine" }),
	).toBeNull();
	expect(described("Analytical Engine")).toBe("Analytical Engine · 1 link");
	fireEvent.click(screen.getByRole("checkbox", { name: "Show unresolved" }));
	await graphCanvas("Graph of 4 notes and 3 links");

	// Selecting a note opens it; the note links back to the graph.
	fireEvent.click(
		within(graphRegion()).getByRole("link", { name: "Ada Lovelace" }),
	);
	await screen.findByRole("heading", { name: "Ada Lovelace" });
	expectHash("synapse/shared/Ada%20Lovelace");
	expect(screen.queryByRole("region", { name: "Graph" })).toBeNull();
	fireEvent.click(
		within(noteRegion()).getByRole("link", { name: "Back to graph" }),
	);
	expectHash("synapse/shared");
	const back = within(await graphCanvas("Graph of 4 notes and 3 links"));
	// The note the viewer came from is marked.
	expect(
		back
			.getByRole("link", { name: "Ada Lovelace" })
			.classList.contains("current"),
	).toBe(true);
	expect(
		back.getByRole("link", { name: "Loner" }).classList.contains("current"),
	).toBe(false);

	// An unresolved link opens the New note form with its title; creating
	// the note resolves it in the graph.
	fireEvent.click(
		back.getByRole("button", { name: "Create note Difference Engine" }),
	);
	expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
		"Difference Engine",
	);
	fireEvent.click(screen.getByRole("button", { name: "Create note" }));
	await screen.findByRole("heading", { name: "Difference Engine" });
	fireEvent.click(screen.getByRole("link", { name: "Back to graph" }));
	const resolved = within(await graphCanvas("Graph of 5 notes and 3 links"));
	expect(
		resolved.getByRole("link", { name: "Difference Engine" }),
	).toBeDefined();
	expect(resolved.queryByRole("button")).toBeNull();
	expect(
		screen.queryByRole("checkbox", { name: "Show unresolved" }),
	).toBeNull();
});

it("marks notes inherited from Global in the Shared graph and redraws per space", async () => {
	const running = await boot();
	await createNote(running, "global", {
		title: "Brand voice",
		body: "Plain words.",
	});
	await createNote(running, "shared", {
		title: "Trailer plan",
		body: "Follow the [[Brand voice]].",
	});
	renderAt("#/synapse");
	const shared = within(await graphCanvas("Graph of 2 notes and 1 link"));
	const inherited = shared.getByRole("link", { name: "Brand voice" });
	expect(inherited.classList.contains("inherited")).toBe(true);
	expect(inherited.querySelector("title")?.textContent).toBe(
		"Brand voice · inherited from Global · 1 link",
	);
	expect(
		shared
			.getByRole("link", { name: "Trailer plan" })
			.classList.contains("inherited"),
	).toBe(false);
	expect(
		within(screen.getByRole("list", { name: "Legend" })).getByText(
			"Inherited from Global",
		),
	).toBeDefined();
	// In Global the note is simply a note.
	await pickSpace("global");
	const global = within(await graphCanvas("Graph of 1 note and 0 links"));
	expect(
		global
			.getByRole("link", { name: "Brand voice" })
			.classList.contains("inherited"),
	).toBe(false);
	expect(global.queryByRole("link", { name: "Trailer plan" })).toBeNull();
	expect(
		within(screen.getByRole("list", { name: "Legend" })).queryByText(
			"Inherited from Global",
		),
	).toBeNull();
});

it("says so when the graph is empty, capped, or cannot load, and settles at once for reduced motion", async () => {
	const running = await start();
	expect(await screen.findByText(/Nothing to draw yet/)).toBeDefined();
	expect(screen.queryByRole("group", { name: /^Graph of/ })).toBeNull();
	expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
	// With reduced motion the layout is finished before the first paint.
	vi.stubGlobal(
		"matchMedia",
		(query: string) =>
			({ matches: query.includes("prefers-reduced-motion") }) as MediaQueryList,
	);
	const frames = vi.spyOn(window, "requestAnimationFrame");
	// More notes than the graph draws: a hub and its leaves, in import-sized batches.
	const titles = Array.from(
		{ length: 1001 },
		(_, index) => `Leaf ${String(index).padStart(4, "0")}`,
	);
	for (let at = 0; at < titles.length; at += 400) {
		const response = await running.server.inject({
			method: "POST",
			url: "/v1/synapse/spaces/shared/import",
			headers: running.owner,
			payload: {
				files: titles
					.slice(at, at + 400)
					.map((title) => ({ path: `${title}.md`, content: "[[Hub]]" })),
			},
		});
		expect(response.statusCode, response.body).toBe(200);
	}
	await createNote(running, "shared", { title: "Hub", body: "" });
	// Any change to the space redraws the graph.
	await pickSpace("global");
	await screen.findByText(/owners and admins change it/);
	await pickSpace("shared");
	const canvas = await graphCanvas("Graph of 1,000 notes and 999 links");
	expect(
		screen.getByText("Showing the 1,000 most-linked of 1,002 notes."),
	).toBeDefined();
	expect(canvas.querySelectorAll("[data-index]:not([transform])")).toHaveLength(
		0,
	);
	expect(frames).not.toHaveBeenCalled();
	// Zoomed out to fit, only the dozen best-linked notes are labelled.
	expect(canvas.hasAttribute("data-zoomed")).toBe(false);
	expect(canvas.querySelectorAll("[data-index].major")).toHaveLength(12);
	expect(
		within(canvas)
			.getByRole("link", { name: "Hub" })
			.classList.contains("major"),
	).toBe(true);

	// A graph that cannot load says what went wrong and offers a retry.
	await running.server.close();
	await pickSpace("global");
	const alert = await within(graphRegion()).findByRole("alert");
	expect(within(alert).getByRole("button", { name: "Retry" })).toBeDefined();
}, 30_000);

it("expands the graph over the notes column, keeping the page header and navigation, until Esc or the button", async () => {
	const running = await boot();
	await createNote(running, "global", { title: "Brand voice", body: "" });
	await createNote(running, "shared", {
		title: "Ada Lovelace",
		body: "Wrote about the [[Analytical Engine]].",
	});
	renderAt("#/synapse");
	const canvas = await graphCanvas("Graph of 2 notes and 1 link");
	// Every icon-only control says what it does on hover.
	for (const name of [
		"Zoom out",
		"Zoom in",
		"Fit graph to view",
		"Full screen",
	])
		expect(screen.getByRole("button", { name }).getAttribute("title")).toBe(
			name,
		);
	const notes = () => screen.queryByRole("complementary", { name: "Notes" });
	const expandedParts = () =>
		Array.from(document.querySelectorAll(".is-expanded"), (item) =>
			item.className.replace(" is-expanded", ""),
		);
	expect(notes()).not.toBeNull();
	expect(screen.getByRole("heading", { name: "Graph" })).toBeDefined();
	const toggle = screen.getByRole("button", { name: "Full screen" });
	toggle.focus();
	fireEvent.click(toggle);
	// The notes column goes; the graph says which space it shows.
	expect(toggle.getAttribute("aria-label")).toBe("Exit full screen");
	expect(toggle.getAttribute("title")).toBe("Exit full screen");
	expect(document.activeElement).toBe(toggle);
	expect(notes()).toBeNull();
	expect(screen.getByRole("heading", { name: "Graph · Shared" })).toBeDefined();
	expect(expandedParts()).toEqual([
		"dashboard synapse-view",
		"synapse-layout",
		"synapse-graph",
	]);
	// The drawing is the same element, sized to the window.
	expect(await graphCanvas()).toBe(canvas);
	expect(canvas.style.height).toBe(`${window.innerHeight}px`);
	// The page header, its actions, the tabs, and the app navigation stay.
	expect(screen.getByRole("heading", { name: "Synapse" })).toBeDefined();
	expect(screen.getByRole("button", { name: "New note" })).toBeDefined();
	expect(screen.getByRole("tab", { name: "Proposals" })).toBeDefined();
	expect(screen.getByRole("link", { name: "Synapse" })).toBeDefined();
	expect(screen.getByRole("link", { name: "Channels" })).toBeDefined();

	// Esc from inside the graph leaves.
	fireEvent.keyDown(
		within(canvas).getByRole("link", { name: "Ada Lovelace" }),
		{ key: "Escape" },
	);
	expect(toggle.getAttribute("aria-label")).toBe("Full screen");
	expect(notes()).not.toBeNull();
	expect(screen.getByRole("heading", { name: "Graph" })).toBeDefined();
	expect(expandedParts()).toEqual([]);
	expect(canvas.style.height).toBe("");
	// Esc elsewhere on the page is not the graph's.
	fireEvent.click(toggle);
	fireEvent.keyDown(screen.getByRole("tab", { name: "Notes" }), {
		key: "Escape",
	});
	expect(toggle.getAttribute("aria-label")).toBe("Exit full screen");

	// A note opens in the normal layout; going back returns to the expanded graph.
	fireEvent.click(within(canvas).getByRole("link", { name: "Ada Lovelace" }));
	await screen.findByRole("heading", { name: "Ada Lovelace" });
	expect(notes()).not.toBeNull();
	expect(expandedParts()).toEqual([]);
	fireEvent.click(screen.getByRole("link", { name: "Back to graph" }));
	await graphCanvas("Graph of 2 notes and 1 link");
	expect(
		screen.getByRole("button", { name: "Exit full screen" }),
	).toBeDefined();
	expect(notes()).toBeNull();
	// Another space is drawn expanded too, under its own name.
	await pickSpace("global");
	await graphCanvas("Graph of 1 note and 0 links");
	expect(screen.getByRole("heading", { name: "Graph · Global" })).toBeDefined();
	expect(notes()).toBeNull();
	// The Proposals tab is not the graph's to expand.
	fireEvent.click(screen.getByRole("tab", { name: "Proposals" }));
	expect(expandedParts()).toEqual([]);
	fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Exit full screen" }),
	);
	expect(notes()).not.toBeNull();
	expect(screen.getByRole("button", { name: "Full screen" })).toBeDefined();
});
