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
	closers.push(() => server.close());
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
	expect(within(noteRegion()).getByText("Pick a note")).toBeDefined();
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
	closers.push(() => server.close());
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
	fireEvent.change(screen.getByLabelText("Space"), {
		target: { value: "shared" },
	});
	await screen.findByRole("button", { name: "New note" });
	expect(screen.getByRole("link", { name: "Synapse" })).toBeDefined();
	expect(screen.queryByRole("link", { name: "Agent Tokens" })).toBeNull();
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
