import type { SynapseActor, SynapseSpaceId } from "@autonomo.us/common";
import { describe, expect, it } from "vitest";
import { MemorySynapseRepository } from "../src/synapse/memory-repository.js";
import {
	appendLogLine,
	MAX_BODY_LENGTH,
	MAX_PENDING_PROPOSALS,
	PROPOSAL_CLAIM_MS,
	SynapseService,
	sharedSpaceId,
} from "../src/synapse/synapse.js";
import { BUILTIN_TEMPLATES } from "../src/synapse/templates.js";
import { dayRange, localDate, localTime } from "../src/synapse/time.js";

const user: SynapseActor = { kind: "user", id: "u1", name: "Founder" };
const agent: SynapseActor = {
	kind: "agent",
	id: "tok-1",
	name: "Research agent",
};
const agentSpace = "agent-tok-1" as const;

/** A Synapse on the memory repository with a controllable clock in Berlin time. */
function synapse(
	start = Date.parse("2026-11-08T22:30:00Z"),
	timeZone = "Europe/Berlin",
) {
	let now = start;
	const service = new SynapseService(new MemorySynapseRepository(), {
		timeZone,
		now: () => now,
	});
	return {
		service,
		tick(ms = 1000) {
			now += ms;
		},
		set(iso: string) {
			now = Date.parse(iso);
		},
	};
}

describe("time", () => {
	it("computes local dates, times, and day ranges across DST", () => {
		const ms = Date.parse("2026-11-08T22:30:00Z");
		expect(localDate(ms, "UTC")).toBe("2026-11-08");
		expect(localDate(ms, "Europe/Berlin")).toBe("2026-11-08");
		expect(localDate(ms, "Pacific/Auckland")).toBe("2026-11-09");
		expect(localTime(ms, "Europe/Berlin")).toBe("23:30");
		expect(localTime(ms, "America/Los_Angeles")).toBe("14:30");
		expect(dayRange("2026-11-08", "UTC")).toEqual({
			from: "2026-11-08T00:00:00.000Z",
			to: "2026-11-09T00:00:00.000Z",
		});
		expect(dayRange("2026-11-01", "America/New_York")).toEqual({
			from: "2026-11-01T04:00:00.000Z",
			to: "2026-11-02T05:00:00.000Z",
		});
		expect(dayRange("2026-03-29", "Europe/Berlin")).toEqual({
			from: "2026-03-28T23:00:00.000Z",
			to: "2026-03-29T22:00:00.000Z",
		});
	});

	it("starts a day at the clock jump where local midnight does not exist", () => {
		// America/Santiago skips 00:00–00:59 on 2026-09-06.
		const { from, to } = dayRange("2026-09-06", "America/Santiago");
		expect(localDate(Date.parse(from), "America/Santiago")).toBe("2026-09-06");
		expect(localDate(Date.parse(from) - 1, "America/Santiago")).toBe(
			"2026-09-05",
		);
		expect(dayRange("2026-09-05", "America/Santiago").to).toBe(from);
		expect(localDate(Date.parse(to) - 1, "America/Santiago")).toBe(
			"2026-09-06",
		);
	});
});

describe("templates and categories", () => {
	it("ships 13 templates with plural names, descriptions, and {{date}} filling", async () => {
		const { service } = synapse();
		const templates = service.templates();
		expect(templates.map((item) => item.name)).toEqual([
			"People",
			"Companies",
			"Projects",
			"Meetings",
			"Decisions",
			"Evergreen",
			"Clippings",
			"Posts",
			"Events",
			"Products",
			"Places",
			"Journal",
			"Daily",
		]);
		for (const template of BUILTIN_TEMPLATES) {
			expect(template.description.length).toBeGreaterThan(20);
			if (template.category)
				expect(template.properties.categories).toEqual([
					`[[${template.category}]]`,
				]);
			else expect(template.properties.categories).toBeUndefined();
		}
		const note = await service.createNote(
			"shared",
			{
				title: "Ada Lovelace",
				template: "people",
				properties: { role: "Mathematician" },
			},
			user,
		);
		expect(note.properties).toEqual({
			categories: ["[[People]]"],
			org: [],
			role: "Mathematician",
			email: null,
			url: null,
			created: "2026-11-08",
		});
		expect(note).toMatchObject({
			categories: ["People"],
			links: ["People"],
			tags: [],
			revision: 1,
			createdBy: user,
		});
		await expect(
			service.createNote("shared", { title: "X", template: "Nope" }, user),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it("creates missing category notes once, tagged categories, with the template description", async () => {
		const { service } = synapse();
		await service.createNote(
			"shared",
			{ title: "Ada Lovelace", template: "People" },
			user,
		);
		await service.createNote(
			"shared",
			{
				title: "Write-up",
				properties: { categories: ["[[People]]", "[[Custom Things]]"] },
			},
			user,
		);
		const people = await service.getNote("shared", "people");
		expect(people).toMatchObject({
			title: "People",
			tags: ["categories"],
			createdBy: { kind: "system" },
		});
		expect(people.body).toMatch(/People the team works with/);
		expect(await service.getNote("shared", "Custom Things")).toMatchObject({
			body: "",
			tags: ["categories"],
		});
		const categories = await service.categories("shared");
		expect(categories).toEqual([
			{
				title: "People",
				count: 2,
				description: expect.stringMatching(/People the team/),
				exists: true,
			},
			{ title: "Custom Things", count: 1, exists: true },
		]);
		expect((await service.query("shared", {})).total).toBe(4);
		const view = await service.viewNote("shared", "People");
		expect(view.categoryMembers.map((item) => item.title)).toEqual([
			"Ada Lovelace",
			"Write-up",
		]);
	});
});

describe("notes", () => {
	it("enforces titles, duplicates, limits, and revisions", async () => {
		const { service } = synapse();
		await expect(
			service.createNote("shared", { title: "a/b" }, user),
		).rejects.toMatchObject({ statusCode: 400 });
		const note = await service.createNote("shared", { title: "Note" }, user);
		await expect(
			service.createNote("shared", { title: "NOTE" }, user),
		).rejects.toMatchObject({ statusCode: 409 });
		await expect(
			service.createNote(
				"shared",
				{ title: "Big", body: "x".repeat(MAX_BODY_LENGTH + 1) },
				user,
			),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			service.appendNote("shared", "Note", { text: "x".repeat(20_001) }, user),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			service.updateNote("shared", "Note", { body: "new", revision: 5 }, user),
		).rejects.toMatchObject({ statusCode: 409 });
		const updated = await service.updateNote(
			"shared",
			"note",
			{ body: "new", revision: note.revision, properties: { a: 1 } },
			user,
		);
		expect(updated).toMatchObject({
			revision: 2,
			body: "new",
			properties: { a: 1 },
		});
		const merged = await service.updateNote(
			"shared",
			"Note",
			{ properties: { b: null } },
			user,
		);
		expect(merged.properties).toEqual({ a: 1, b: null });
		const replaced = await service.updateNote(
			"shared",
			"Note",
			{ properties: { c: "x" }, replaceProperties: true },
			user,
		);
		expect(replaced.properties).toEqual({ c: "x" });
		const fromMarkdown = await service.updateNote(
			"shared",
			"Note",
			{ markdown: "---\nd: 4\n---\nMarkdown body" },
			user,
		);
		expect(fromMarkdown).toMatchObject({
			properties: { d: 4 },
			body: "Markdown body",
			revision: 5,
		});
		await expect(
			service.updateNote(
				"shared",
				"Note",
				{ markdown: "---\nx: |\n  y\n---\n" },
				user,
			),
		).rejects.toMatchObject({ statusCode: 400 });
		await service.deleteNote("shared", "Note", user);
		await expect(service.getNote("shared", "Note")).rejects.toMatchObject({
			statusCode: 404,
		});
		await expect(
			service.deleteNote("shared", "Note", user),
		).rejects.toMatchObject({
			statusCode: 404,
		});
	});

	it("appends to existing notes or creates them from a template", async () => {
		const { service } = synapse();
		const created = await service.appendNote(
			agentSpace,
			"Scratch",
			{ text: "first line", template: "Journal" },
			agent,
		);
		expect(created.created).toBe(true);
		expect(created.note).toMatchObject({
			body: "first line",
			tags: ["journal"],
			categories: ["Journal"],
		});
		const appended = await service.appendNote(
			agentSpace,
			"Scratch",
			{ text: "second line" },
			agent,
		);
		expect(appended.created).toBe(false);
		expect(appended.note.body).toBe("first line\nsecond line");
		expect(appended.note.revision).toBe(2);
		const spaces = await service.listSpaces();
		expect(spaces.spaces).toEqual([
			expect.objectContaining({ id: "global", kind: "global", noteCount: 0 }),
			expect.objectContaining({
				id: "shared",
				kind: "shared",
				noteCount: 0,
				createdAt: null,
			}),
			expect.objectContaining({
				id: agentSpace,
				kind: "agent",
				name: "Research agent",
				agentTokenId: "tok-1",
				noteCount: 2,
			}),
		]);
		expect(spaces).toMatchObject({
			persistence: "memory",
			timeZone: "Europe/Berlin",
		});
	});

	it("renames notes and rewrites links across the space, keeping aliases and headings", async () => {
		const { service } = synapse();
		await service.createNote(
			"shared",
			{ title: "Old Name", body: "I link [[Old Name#Top]] to myself." },
			user,
		);
		const other = await service.createNote(
			"shared",
			{
				title: "Other",
				body: "See [[old name|the old]] and ![[Old Name]].\n```\n[[Old Name]]\n```",
				properties: { related: ["[[Old Name]]"], categories: ["[[Old Name]]"] },
			},
			user,
		);
		await service.createNote(
			"shared",
			{ title: "Unrelated", body: "No links." },
			user,
		);
		const renamed = await service.updateNote(
			"shared",
			"Old Name",
			{ title: "New Name" },
			user,
		);
		expect(renamed.title).toBe("New Name");
		expect(renamed.body).toBe("I link [[New Name#Top]] to myself.");
		const rewritten = await service.getNote("shared", "Other");
		expect(rewritten.body).toBe(
			"See [[New Name|the old]] and ![[New Name]].\n```\n[[Old Name]]\n```",
		);
		expect(rewritten.properties).toEqual({
			related: ["[[New Name]]"],
			categories: ["[[New Name]]"],
		});
		expect(rewritten.categories).toEqual(["New Name"]);
		expect(rewritten.revision).toBe(other.revision + 1);
		expect((await service.getNote("shared", "Unrelated")).revision).toBe(1);
		await expect(service.getNote("shared", "Old Name")).rejects.toMatchObject({
			statusCode: 404,
		});
		// A rename onto a taken title is refused.
		await expect(
			service.updateNote("shared", "New Name", { title: "unrelated" }, user),
		).rejects.toMatchObject({ statusCode: 409 });
		// A case-only rename keeps the note.
		expect(
			(
				await service.updateNote(
					"shared",
					"New Name",
					{ title: "NEW NAME" },
					user,
				)
			).title,
		).toBe("NEW NAME");
	});
});

describe("finding things", () => {
	it("queries by text, category, tag, backlinks, and property equality with ranking", async () => {
		const { service, tick } = synapse();
		await service.createNote(
			"shared",
			{
				title: "Ada Lovelace",
				template: "People",
				body: "Mathematician. Worked on the engine with [[Charles Babbage]]. #pioneers/women",
			},
			user,
		);
		tick();
		await service.createNote(
			"shared",
			{
				title: "Charles Babbage",
				template: "People",
				body: "Engine engine engine. Friend of [[Ada Lovelace]].",
			},
			user,
		);
		tick();
		await service.createNote(
			"shared",
			{
				title: "Analytical Engine",
				template: "Projects",
				body: "Designed by [[Charles Babbage]]; [[Ada Lovelace]] wrote the notes. #pioneers",
				properties: { status: ["[[Active]]"], year: 1837 },
			},
			user,
		);
		tick();
		await service.createNote(
			"shared",
			{ title: "Engine", body: "Just an engine." },
			user,
		);

		const byText = await service.query("shared", { text: "engine" });
		expect(byText.total).toBe(4);
		expect(byText.notes.map((note) => note.title)).toEqual([
			"Engine",
			"Analytical Engine",
			"Charles Babbage",
			"Ada Lovelace",
		]);
		expect(byText.notes[2].snippet).toContain("Engine engine engine");
		expect(byText.notes[3].snippet).toContain("engine with Charles Babbage");
		expect(
			(await service.query("shared", { text: "ada ENGINE" })).notes.map(
				(n) => n.title,
			),
		).toEqual(["Charles Babbage", "Analytical Engine", "Ada Lovelace"]);
		expect(
			(await service.query("shared", { category: "people" })).notes.map(
				(n) => n.title,
			),
		).toEqual(["Charles Babbage", "Ada Lovelace"]);
		expect(
			(
				await service.query("shared", { tag: "#Pioneers", sort: "title" })
			).notes.map((n) => n.title),
		).toEqual(["Ada Lovelace", "Analytical Engine"]);
		expect(
			(await service.query("shared", { linksTo: "charles babbage" })).notes.map(
				(n) => n.title,
			),
		).toEqual(["Analytical Engine", "Ada Lovelace"]);
		expect(
			(
				await service.query("shared", { where: { status: "active" } })
			).notes.map((n) => n.title),
		).toEqual(["Analytical Engine"]);
		expect(
			(await service.query("shared", { where: { year: "1837" } })).total,
		).toBe(1);
		expect(
			(
				await service.query("shared", {
					where: { year: 1837, status: "[[Active]]" },
				})
			).total,
		).toBe(1);
		expect(
			(await service.query("shared", { where: { status: "done" } })).total,
		).toBe(0);
		const paged = await service.query("shared", {
			sort: "title",
			limit: 2,
			offset: 1,
		});
		expect(paged.notes.map((n) => n.title)).toEqual([
			"Analytical Engine",
			"Charles Babbage",
		]);
		expect(paged.total).toBe(6);
		expect((await service.query("shared", { limit: 1000 })).notes.length).toBe(
			6,
		);
	});

	it("computes backlinks, outgoing, related, and unresolved links", async () => {
		const { service, tick } = synapse();
		const make = (title: string, body: string, properties = {}) => {
			tick();
			return service.createNote("shared", { title, body, properties }, user);
		};
		await make("Hub", "Links [[A]], [[B]], [[C]], and [[Ghost]].", {
			categories: ["[[Topics]]"],
		});
		await make("Twin", "Also [[A]], [[B]], [[C]].", {
			categories: ["[[Topics]]"],
		});
		await make("Pair", "Only [[A]] and [[B]].", { categories: ["[[Topics]]"] });
		await make("Backlinker", "Points at [[Hub]] and [[Ghost]] and [[ghost]].");
		await make("A", "");
		await make("B", "Links [[Hub]].");
		const view = await service.viewNote("shared", "Hub");
		expect(view.backlinks.map((n) => n.title)).toEqual(["B", "Backlinker"]);
		expect(view.outgoing).toEqual([
			{ title: "Topics", exists: true },
			{ title: "A", exists: true },
			{ title: "B", exists: true },
			{ title: "C", exists: false },
			{ title: "Ghost", exists: false },
		]);
		// Twin shares Topics, A, B, C (4 > 2); Pair shares 3 (Topics, A, B);
		// Backlinker shares the unresolved Ghost and is direct; A, B, and Topics
		// are direct (Hub links to them) and tie, so they sort by title.
		expect(view.related.map((n) => [n.title, n.sharedLinks, n.direct])).toEqual(
			[
				["Twin", ["Topics", "A", "B", "C"], false],
				["Pair", ["Topics", "A", "B"], false],
				["Backlinker", ["Ghost"], true],
				["A", [], true],
				["B", [], true],
				["Topics", [], true],
			],
		);
		expect(view.markdown).toBe(
			'---\ncategories:\n  - "[[Topics]]"\n---\nLinks [[A]], [[B]], [[C]], and [[Ghost]].',
		);
		expect(await service.unresolved("shared")).toEqual([
			{ title: "C", count: 2, sources: ["Hub", "Twin"] },
			{ title: "Ghost", count: 2, sources: ["Hub", "Backlinker"] },
		]);
		expect(await service.unresolved("shared", 1)).toHaveLength(1);
		await service.deleteNote("shared", "A", user);
		expect((await service.unresolved("shared")).map((l) => l.title)).toEqual([
			"A",
			"C",
			"Ghost",
		]);
	});

	it("lists a day's notes from titles, creation, date properties, and links", async () => {
		const { service, set } = synapse();
		set("2026-11-08T10:00:00Z");
		await service.createNote(
			agentSpace,
			{ title: "Created today", body: "" },
			agent,
		);
		await service.createNote(
			agentSpace,
			{ title: "2026-11-08 standup", body: "" },
			agent,
		);
		await service.createNote(
			agentSpace,
			{ title: "Links the day", body: "See [[2026-11-08]]." },
			agent,
		);
		await service.createNote(
			agentSpace,
			{ title: "Planned meeting", properties: { date: "2026-11-08" } },
			agent,
		);
		await service.createNote(
			agentSpace,
			{
				title: "Published then",
				properties: { published: "2026-11-08T09:00" },
			},
			agent,
		);
		set("2026-11-09T10:00:00Z");
		await service.createNote(
			agentSpace,
			{ title: "Tomorrow", body: "" },
			agent,
		);
		await service.createNote(
			agentSpace,
			{ title: "Old event", properties: { start: "2026-11-01" } },
			agent,
		);
		set("2026-11-08T23:30:00Z"); // 00:30 on the 9th in Berlin
		await service.createNote(
			agentSpace,
			{ title: "Late night", body: "" },
			agent,
		);
		expect(await service.daily(agentSpace, "2026-11-08")).toMatchObject({
			date: "2026-11-08",
			note: null,
		});
		set("2026-11-08T12:00:00Z");
		const daily = await service.log(
			agentSpace,
			"Wrote the [[Planned meeting]] agenda",
			agent,
		);
		expect(daily).toMatchObject({ title: "2026-11-08", tags: ["daily"] });
		expect(daily.body).toBe(
			"## Log\n- 13:00 Wrote the [[Planned meeting]] agenda",
		);
		const day = await service.daily(agentSpace, "2026-11-08");
		expect(day.note?.title).toBe("2026-11-08");
		expect(day.entries.map((n) => n.title).sort()).toEqual([
			"2026-11-08 standup",
			"Created today",
			"Links the day",
			"Planned meeting",
			"Published then",
		]);
		expect(
			(await service.daily(agentSpace, "2026-11-09")).entries
				.map((n) => n.title)
				.sort(),
		).toEqual(["Late night", "Old event", "Tomorrow"]);
		await expect(service.daily(agentSpace, "2026-13-01")).rejects.toMatchObject(
			{
				statusCode: 400,
			},
		);
	});
});

describe("log", () => {
	it("lands concurrent first writes of the day instead of failing one with 409", async () => {
		const { service } = synapse();
		const logs = await Promise.allSettled([
			service.log(agentSpace, "first", agent),
			service.log(agentSpace, "second", agent),
		]);
		expect(logs.map((result) => result.status)).toEqual([
			"fulfilled",
			"fulfilled",
		]);
		const daily = await service.getNote(agentSpace, "2026-11-08");
		expect(daily.body).toContain("first");
		expect(daily.body).toContain("second");
		const appends = await Promise.allSettled([
			service.appendNote(agentSpace, "Ideas", { text: "one" }, agent),
			service.appendNote(agentSpace, "Ideas", { text: "two" }, agent),
		]);
		expect(appends.map((result) => result.status)).toEqual([
			"fulfilled",
			"fulfilled",
		]);
		const ideas = await service.getNote(agentSpace, "Ideas");
		expect(ideas.body).toContain("one");
		expect(ideas.body).toContain("two");
	});

	it("appends timestamped lines under ## Log, creating the heading at the end when missing", async () => {
		expect(appendLogLine("", "- 09:00 a")).toBe("## Log\n- 09:00 a");
		// A heading inside a code block is not the log section.
		const nested = "````md\n```ts\n## Log\n```\n````\n\n## Log\n- 08:00 x";
		expect(appendLogLine(nested, "- 09:00 a")).toBe(`${nested}\n- 09:00 a`);
		expect(appendLogLine("```\n## Log\n```", "- 09:00 a")).toBe(
			"```\n## Log\n```\n\n## Log\n- 09:00 a",
		);
		expect(appendLogLine("Intro\n", "- 09:00 a")).toBe(
			"Intro\n\n## Log\n- 09:00 a",
		);
		expect(
			appendLogLine("## Log\n- 08:00 x\n\n## Notes\nText", "- 09:00 a"),
		).toBe("## Log\n- 08:00 x\n- 09:00 a\n\n## Notes\nText");
		expect(appendLogLine("## Log\n", "- 09:00 a")).toBe("## Log\n- 09:00 a");
		const { service, tick } = synapse(Date.parse("2026-11-08T08:05:00Z"));
		const first = await service.log(agentSpace, "Started [[Project X]]", agent);
		expect(first.body).toBe("## Log\n- 09:05 Started [[Project X]]");
		tick(60_000);
		const second = await service.log(agentSpace, "  Finished  ", agent);
		expect(second.body).toBe(
			"## Log\n- 09:05 Started [[Project X]]\n- 09:06 Finished",
		);
		expect(second.revision).toBe(2);
		expect((await service.unresolved(agentSpace)).map((l) => l.title)).toEqual([
			"Project X",
		]);
		await expect(service.log(agentSpace, "   ", agent)).rejects.toMatchObject({
			statusCode: 400,
		});
	});
});

describe("export and import", () => {
	it("exports notes into folders with templates and imports them back", async () => {
		const { service } = synapse();
		await service.createNote(
			"shared",
			{ title: "Ada Lovelace", template: "People", body: "Body" },
			user,
		);
		await service.createNote(
			"shared",
			{ title: "Launch", template: "Events" },
			user,
		);
		await service.createNote(
			"shared",
			{ title: "Article", template: "Clippings" },
			user,
		);
		await service.createNote(
			"shared",
			{ title: "Loose", body: "No properties" },
			user,
		);
		await service.log("shared", "Logged", user);
		await service.createNote(
			"shared",
			{
				title: "Multi",
				properties: { categories: ["[[Events]]", "[[People]]"] },
			},
			user,
		);
		const exported = await service.exportSpace("shared");
		const paths = exported.files.map((file) => file.path);
		expect(paths).toEqual(
			expect.arrayContaining([
				"References/Ada Lovelace.md",
				"Launch.md",
				"Clippings/Article.md",
				"Loose.md",
				"Daily/2026-11-08.md",
				"References/Multi.md",
				"Categories/People.md",
				"Categories/Events.md",
				"Categories/Clippings.md",
				"Templates/People Template.md",
				"Templates/Daily Template.md",
			]),
		);
		expect(paths.filter((path) => path.startsWith("Templates/"))).toHaveLength(
			13,
		);
		expect(exported.files.find((f) => f.path === "Loose.md")?.content).toBe(
			"No properties",
		);
		expect(
			exported.files.find((f) => f.path === "Templates/People Template.md")
				?.content,
		).toBe(
			'---\ncategories:\n  - "[[People]]"\norg: []\nrole:\nemail:\nurl:\ncreated: {{date}}\n---\n',
		);
		expect(
			exported.files.find((f) => f.path === "References/Ada Lovelace.md")
				?.content,
		).toContain("created: 2026-11-08\n---\nBody");

		const fresh = synapse();
		const result = await fresh.service.importSpace(
			agentSpace,
			{
				files: [
					...exported.files,
					{ path: ".obsidian/app.json", content: "{}" },
					{ path: "Attachments/photo.png", content: "" },
					{ path: "bad:title.md", content: "" },
					{ path: "Nested/.trash/Gone.md", content: "" },
					{ path: "Broken.md", content: "---\nx: |\n  y\n---\n" },
					{ path: "Dup/Loose.md", content: "duplicate" },
					{ path: "Huge.md", content: "x".repeat(MAX_BODY_LENGTH + 1) },
				],
			},
			agent,
		);
		expect(result.created.sort()).toEqual(
			[
				"Ada Lovelace",
				"Launch",
				"Article",
				"Loose",
				"2026-11-08",
				"Multi",
				"People",
				"Events",
				"Clippings",
			].sort(),
		);
		expect(result.updated).toEqual([]);
		expect(result.skipped).toEqual([
			...exported.files
				.filter((f) => f.path.startsWith("Templates/"))
				.map((f) => ({
					path: f.path,
					reason: expect.stringMatching(/Templates/),
				})),
			{
				path: ".obsidian/app.json",
				reason: expect.stringMatching(/dot-folders/),
			},
			{ path: "Attachments/photo.png", reason: expect.stringMatching(/\.md/) },
			{ path: "bad:title.md", reason: expect.stringMatching(/cannot contain/) },
			{
				path: "Nested/.trash/Gone.md",
				reason: expect.stringMatching(/dot-folders/),
			},
			{
				path: "Broken.md",
				reason: expect.stringMatching(/Block scalars.*line 2/),
			},
			{ path: "Dup/Loose.md", reason: expect.stringMatching(/same title/) },
			{ path: "Huge.md", reason: expect.stringMatching(/100,000/) },
		]);
		const imported = await fresh.service.getNote(agentSpace, "Ada Lovelace");
		expect(imported).toMatchObject({
			body: "Body",
			categories: ["People"],
			properties: { created: "2026-11-08", role: null },
		});
		const again = await fresh.service.importSpace(
			agentSpace,
			{
				files: [{ path: "Loose.md", content: "---\nnew: true\n---\nChanged" }],
			},
			agent,
		);
		expect(again.skipped).toEqual([
			{ path: "Loose.md", reason: expect.stringMatching(/already exists/) },
		]);
		const overwritten = await fresh.service.importSpace(
			agentSpace,
			{
				files: [
					{
						path: "Loose.md",
						content: '---\nnew: true\ncategories: ["[[Fresh]]"]\n---\nChanged',
					},
				],
				overwrite: true,
			},
			agent,
		);
		expect(overwritten.updated).toEqual(["Loose"]);
		expect(await fresh.service.getNote(agentSpace, "Loose")).toMatchObject({
			body: "Changed",
			properties: { new: true, categories: ["[[Fresh]]"] },
			revision: 2,
		});
		expect(await fresh.service.getNote(agentSpace, "Fresh")).toMatchObject({
			tags: ["categories"],
		});
	});
});

describe("import across batches", () => {
	it("lets a category's real file replace the placeholder an earlier batch generated", async () => {
		const { service } = synapse();
		await service.importSpace(
			agentSpace,
			{
				files: [
					{
						path: "Ada Lovelace.md",
						content:
							'---\ncategories:\n  - "[[People]]"\n---\nFirst programmer.',
					},
				],
			},
			user,
		);
		expect((await service.getNote(agentSpace, "People")).createdBy.kind).toBe(
			"system",
		);
		const second = await service.importSpace(
			agentSpace,
			{
				files: [
					{ path: "Categories/People.md", content: "Everyone we work with." },
				],
			},
			user,
		);
		expect(second).toMatchObject({ created: ["People"], skipped: [] });
		expect((await service.getNote(agentSpace, "People")).body).toBe(
			"Everyone we work with.",
		);
		// A note someone wrote or edited is still protected without overwrite.
		await service.createNote(agentSpace, { title: "Mine", body: "kept" }, user);
		const third = await service.importSpace(
			agentSpace,
			{
				files: [
					{ path: "Mine.md", content: "replaced?" },
					{ path: "People.md", content: "again?" },
				],
			},
			user,
		);
		expect(third.created).toEqual([]);
		expect(third.skipped.map((item) => item.path)).toEqual([
			"Mine.md",
			"People.md",
		]);
		expect((await service.getNote(agentSpace, "Mine")).body).toBe("kept");
	});
});

/** Runs queued hooks inside repository calls, to land a concurrent change in a precise gap. */
class InterleavedRepository extends MemorySynapseRepository {
	beforeGetNote: Array<(() => Promise<unknown>) | undefined> = [];
	beforeDelete?: () => Promise<unknown>;
	override async getNote(space: SynapseSpaceId, key: string) {
		await this.beforeGetNote.shift()?.();
		return super.getNote(space, key);
	}
	override async deleteNote(id: string, expectedRevision?: number) {
		const hook = this.beforeDelete;
		this.beforeDelete = undefined;
		await hook?.();
		return super.deleteNote(id, expectedRevision);
	}
}

describe("proposals", () => {
	it("validates each action and bounds pending proposals", async () => {
		const { service } = synapse();
		await service.createNote("shared", { title: "Canon", body: "v1" }, user);
		await expect(
			service.propose(agent, {
				action: "create",
				title: "Canon",
				body: "x",
				reason: "r",
			}),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			service.propose(agent, { action: "create", title: "New", reason: "r" }),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			service.propose(agent, {
				action: "update",
				title: "Missing",
				body: "x",
				reason: "r",
			}),
		).rejects.toMatchObject({ statusCode: 404 });
		await expect(
			service.propose(agent, { action: "update", title: "Canon", reason: "r" }),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			service.propose(agent, { action: "append", title: "Canon", reason: "r" }),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			service.propose(agent, {
				action: "delete",
				title: "Canon",
				reason: "  ",
			}),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			service.propose(agent, {
				action: "rename" as "update",
				title: "Canon",
				reason: "r",
			}),
		).rejects.toMatchObject({ statusCode: 400 });
		const proposal = await service.propose(agent, {
			action: "append",
			title: "Canon",
			text: "more",
			reason: "Because",
		});
		expect(proposal).toMatchObject({
			space: "shared",
			status: "pending",
			author: agent,
			baseRevision: 1,
			text: "more",
		});
		expect(proposal).not.toHaveProperty("body");
		for (let index = 1; index < MAX_PENDING_PROPOSALS; index++)
			await service.propose(agent, {
				action: "create",
				title: `N${index}`,
				body: "b",
				reason: "r",
			});
		await expect(
			service.propose(agent, {
				action: "create",
				title: "One more",
				body: "b",
				reason: "r",
			}),
		).rejects.toMatchObject({ statusCode: 400 });
		const other: SynapseActor = { kind: "agent", id: "tok-2", name: "Other" };
		await service.propose(other, {
			action: "create",
			title: "Fine",
			body: "b",
			reason: "r",
		});
		expect(await service.listProposals({ authorId: "tok-2" })).toHaveLength(1);
		expect(await service.listProposals({ status: "pending" })).toHaveLength(
			MAX_PENDING_PROPOSALS + 1,
		);
	});

	it("approves as the reviewer, rejects with a logged reason, and detects stale proposals", async () => {
		const { service, tick } = synapse();
		await service.createNote("shared", { title: "Canon", body: "v1" }, user);
		const create = await service.propose(agent, {
			action: "create",
			title: "Brand voice",
			body: "Warm and direct.",
			properties: { categories: ["[[Decisions]]"] },
			reason: "We keep repeating this.",
		});
		tick();
		const append = await service.propose(agent, {
			action: "append",
			title: "Canon",
			text: "v2 line",
			reason: "More detail",
		});
		tick();
		const rename = await service.propose(agent, {
			action: "update",
			title: "Canon",
			newTitle: "The Canon",
			properties: { status: ["[[Active]]"] },
			reason: "Better name",
		});
		tick();
		const remove = await service.propose(agent, {
			action: "delete",
			title: "Canon",
			reason: "Obsolete",
		});
		const reviewer: SynapseActor = {
			kind: "user",
			id: "u2",
			name: "Admin Ann",
		};

		tick();
		const approved = await service.decideProposal(
			create.id,
			{ decision: "approve" },
			reviewer,
		);
		expect(approved).toMatchObject({ status: "approved", decidedBy: reviewer });
		expect(await service.getNote("shared", "Brand voice")).toMatchObject({
			body: "Warm and direct.",
			categories: ["Decisions"],
			createdBy: reviewer,
		});
		expect(await service.getNote("shared", "Decisions")).toMatchObject({
			tags: ["categories"],
		});
		await expect(
			service.decideProposal(create.id, { decision: "approve" }, reviewer),
		).rejects.toMatchObject({ statusCode: 409 });

		await expect(
			service.decideProposal(append.id, { decision: "reject" }, reviewer),
		).rejects.toMatchObject({ statusCode: 400 });
		await expect(
			service.decideProposal(
				"00000000-0000-0000-0000-000000000000",
				{ decision: "approve" },
				reviewer,
			),
		).rejects.toMatchObject({ statusCode: 404 });
		const rejected = await service.decideProposal(
			append.id,
			{ decision: "reject", reason: "Too vague" },
			reviewer,
		);
		expect(rejected).toMatchObject({
			status: "rejected",
			decisionReason: "Too vague",
			decidedBy: reviewer,
		});
		const daily = await service.getNote(agentSpace, "2026-11-08");
		expect(daily.body).toBe(
			"## Log\n- 23:30 Proposal to append [[Canon]] in the shared space was rejected by Admin Ann: Too vague",
		);
		// The space was created by the rejection, yet it carries the agent's name.
		expect(
			(await service.listSpaces()).spaces.find((v) => v.id === agentSpace),
		).toMatchObject({
			name: "Research agent",
			noteCount: 1,
		});

		// The shared note moved on, so the rename is stale and stays pending.
		await service.appendNote("shared", "Canon", { text: "edited" }, user);
		await expect(
			service.decideProposal(rename.id, { decision: "approve" }, reviewer),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(
			(await service.listProposals({ status: "pending" })).map((p) => p.id),
		).toEqual([remove.id, rename.id]);
		await service.deleteNote("shared", "Canon", user);
		await expect(
			service.decideProposal(remove.id, { decision: "approve" }, reviewer),
		).rejects.toMatchObject({ statusCode: 409 });
		await service.createNote("shared", { title: "Taken", body: "" }, user);
		tick();
		const dupe = await service.propose(agent, {
			action: "create",
			title: "Fresh",
			body: "b",
			reason: "r",
		});
		await service.createNote("shared", { title: "fresh", body: "" }, user);
		await expect(
			service.decideProposal(dupe.id, { decision: "approve" }, reviewer),
		).rejects.toMatchObject({ statusCode: 409 });

		// A fresh update proposal applies with rename, properties, and the reviewer as actor.
		await service.createNote("shared", { title: "Draft", body: "d" }, user);
		tick();
		const fix = await service.propose(agent, {
			action: "update",
			title: "Draft",
			newTitle: "Final",
			properties: { status: ["[[Active]]"] },
			body: "f",
			reason: "Ship it",
		});
		await service.decideProposal(
			fix.id,
			{ decision: "approve", reason: "Looks good" },
			reviewer,
		);
		expect(await service.getNote("shared", "Final")).toMatchObject({
			body: "f",
			properties: { status: ["[[Active]]"] },
			updatedBy: reviewer,
			revision: 2,
		});
		expect((await service.listProposals({})).map((p) => p.status)).toEqual([
			"approved",
			"pending",
			"pending",
			"pending",
			"rejected",
			"approved",
		]);
	});

	it("claims a proposal before applying it and never overwrites a newer shared revision", async () => {
		const repository = new InterleavedRepository();
		const service = new SynapseService(repository, {
			timeZone: "UTC",
			now: () => Date.parse("2026-11-08T12:00:00Z"),
		});
		const reviewer: SynapseActor = {
			kind: "user",
			id: "u2",
			name: "Admin Ann",
		};
		const other: SynapseActor = { kind: "user", id: "u3", name: "Owner Olu" };
		await service.createNote("shared", { title: "Canon", body: "v1" }, user);
		const status = async (id: string) =>
			(await service.listProposals({})).find((p) => p.id === id)?.status;

		// A rejection that arrives while an approval is applying loses cleanly.
		const append = await service.propose(agent, {
			action: "append",
			title: "Canon",
			text: "agent line",
			reason: "More detail",
		});
		let concurrent: Promise<unknown> | undefined;
		repository.beforeGetNote = [
			async () => {
				concurrent = service
					.decideProposal(
						append.id,
						{ decision: "reject", reason: "No" },
						other,
					)
					.catch((error) => error);
				await concurrent;
			},
		];
		await service.decideProposal(append.id, { decision: "approve" }, reviewer);
		expect(await concurrent).toMatchObject({ statusCode: 409 });
		expect(await status(append.id)).toBe("approved");
		expect((await service.getNote("shared", "Canon")).body).toBe(
			"v1\nagent line",
		);

		// An edit landing between the staleness check and the append is a conflict.
		const late = await service.propose(agent, {
			action: "append",
			title: "Canon",
			text: "late line",
			reason: "r",
		});
		repository.beforeGetNote = [
			undefined,
			() => service.appendNote("shared", "Canon", { text: "human" }, user),
		];
		await expect(
			service.decideProposal(late.id, { decision: "approve" }, reviewer),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(await status(late.id)).toBe("pending");
		expect((await service.getNote("shared", "Canon")).body).not.toContain(
			"late line",
		);

		// An edit landing just before the delete keeps the note.
		const remove = await service.propose(agent, {
			action: "delete",
			title: "Canon",
			reason: "Obsolete",
		});
		repository.beforeDelete = () =>
			service.appendNote("shared", "Canon", { text: "newer" }, user);
		await expect(
			service.decideProposal(remove.id, { decision: "approve" }, reviewer),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(await status(remove.id)).toBe("pending");
		expect((await service.getNote("shared", "Canon")).body).toContain("newer");
	});

	it("keeps a proposal pending when an approval dies mid-way, until its claim expires", async () => {
		const repository = new MemorySynapseRepository();
		let now = Date.parse("2026-11-08T12:00:00Z");
		const service = new SynapseService(repository, {
			timeZone: "UTC",
			now: () => now,
		});
		const reviewer: SynapseActor = {
			kind: "user",
			id: "u2",
			name: "Admin Ann",
		};
		await service.createNote("shared", { title: "Canon", body: "v1" }, user);
		const proposal = await service.propose(agent, {
			action: "append",
			title: "Canon",
			text: "agent line",
			reason: "r",
		});
		// An approval claimed the proposal and then its process died.
		const claimed = await repository.claimProposal(
			proposal.id,
			{
				id: "dead",
				until: new Date(now + PROPOSAL_CLAIM_MS).toISOString(),
			},
			new Date(now).toISOString(),
		);
		expect(claimed).toBe(true);
		expect((await service.listProposals({}))[0]).toMatchObject({
			status: "pending",
		});
		expect((await service.listProposals({}))[0]).not.toHaveProperty("claim");
		for (const decision of [
			{ decision: "approve" as const },
			{ decision: "reject" as const, reason: "No" },
		])
			await expect(
				service.decideProposal(proposal.id, decision, reviewer),
			).rejects.toMatchObject({
				statusCode: 409,
				message: expect.stringMatching(/Someone else is deciding/),
			});
		now += PROPOSAL_CLAIM_MS;
		expect(
			await service.decideProposal(
				proposal.id,
				{ decision: "approve" },
				reviewer,
			),
		).toMatchObject({ status: "approved", decidedBy: reviewer });
		expect((await service.getNote("shared", "Canon")).body).toBe(
			"v1\nagent line",
		);
	});
});

describe("global inheritance", () => {
	const film = sharedSpaceId({ id: "film", isDefault: false });
	const games = sharedSpaceId({ id: "games", isDefault: false });

	it("shows global notes in every workspace's shared space until a workspace overrides them", async () => {
		const { service, tick } = synapse();
		expect(film).toBe("shared-film");
		expect(sharedSpaceId({ id: "default-id", isDefault: true })).toBe("shared");
		await service.createNote(
			"global",
			{
				title: "Brand voice",
				body: "Plain words. See [[Style guide]].",
				template: "Evergreen",
			},
			user,
		);
		tick();
		await service.createNote(
			"global",
			{ title: "Style guide", body: "Short sentences." },
			user,
		);
		tick();
		await service.createNote(
			film,
			{ title: "Trailer plan", body: "Follow the [[Brand voice]]." },
			user,
		);

		// Each workspace and the default see the global notes as their own.
		for (const space of [film, games, "shared"] as SynapseSpaceId[]) {
			const viewed = await service.viewNote(space, "Brand voice");
			expect(viewed.note).toMatchObject({ space: "global", revision: 1 });
			expect(viewed.outgoing).toEqual([
				{ title: "Evergreen", exists: true },
				{ title: "Style guide", exists: true },
			]);
		}
		const listed = await service.query(film, { sort: "title" });
		expect(listed.notes.map((note) => [note.title, note.space])).toEqual([
			["Brand voice", "global"],
			["Evergreen", "global"],
			["Style guide", "global"],
			["Trailer plan", "shared"],
		]);
		expect(listed.total).toBe(4);
		// Paging walks one merged order.
		const page = await service.query(film, {
			sort: "title",
			limit: 2,
			offset: 1,
		});
		expect(page.notes.map((note) => note.title)).toEqual([
			"Evergreen",
			"Style guide",
		]);
		expect(
			(await service.query(games, { text: "trailer" })).notes,
		).toHaveLength(0);
		// Links into global are resolved, and backlinks span both layers.
		expect(await service.unresolved(film)).toEqual([]);
		expect(
			(await service.viewNote(film, "Brand voice")).backlinks.map(
				(note) => note.title,
			),
		).toEqual(["Trailer plan"]);
		expect(
			(await service.categories(film)).find(
				(item) => item.title === "Evergreen",
			),
		).toMatchObject({ count: 1, exists: true });

		// Inherited notes are read-only in the workspace.
		const readOnly = /inherited from the global Synapse/;
		await expect(
			service.updateNote(film, "Brand voice", { body: "Loud." }, user),
		).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringMatching(readOnly),
		});
		await expect(
			service.appendNote(film, "Brand voice", { text: "More." }, user),
		).rejects.toMatchObject({ statusCode: 409 });
		await expect(
			service.deleteNote(film, "Brand voice", user),
		).rejects.toMatchObject({ statusCode: 409 });

		// Creating a note with the same title overrides it in that workspace only.
		tick();
		const override = await service.createNote(
			film,
			{ title: "Brand voice", body: "Cinematic and warm." },
			user,
		);
		expect(override.space).toBe("shared");
		expect((await service.getNote(film, "Brand voice")).body).toBe(
			"Cinematic and warm.",
		);
		expect((await service.getNote(games, "Brand voice")).body).toBe(
			"Plain words. See [[Style guide]].",
		);
		expect((await service.getNote("global", "Brand voice")).body).toBe(
			"Plain words. See [[Style guide]].",
		);
		const after = await service.query(film, { sort: "title" });
		expect(after.notes.map((note) => [note.title, note.space])).toEqual([
			["Brand voice", "shared"],
			["Evergreen", "global"],
			["Style guide", "global"],
			["Trailer plan", "shared"],
		]);
		expect(after.total).toBe(4);
		expect(
			await service.updateNote(film, "Brand voice", { body: "Warm." }, user),
		).toMatchObject({ revision: 2, space: "shared" });

		// Export and the note limit cover the workspace's own notes only.
		const exported = await service.exportSpace(film);
		expect(exported.space).toBe("shared");
		expect(
			exported.files
				.map((file) => file.path)
				.filter((path) => !path.startsWith("Templates/"))
				.sort(),
		).toEqual(["Brand voice.md", "Trailer plan.md"]);
		// Renaming a workspace note leaves global notes alone.
		await service.updateNote(
			film,
			"Trailer plan",
			{ title: "Teaser plan" },
			user,
		);
		expect((await service.getNote("global", "Style guide")).revision).toBe(1);

		const spaces = await service.listSpaces({
			shared: film,
			agentTokenIds: new Set(),
		});
		expect(spaces.spaces.map((space) => [space.id, space.noteCount])).toEqual([
			["global", 3],
			["shared", 2],
		]);
	});

	it("rewrites links in inheriting workspaces when a global note is renamed", async () => {
		const { service } = synapse();
		await service.createNote(
			"global",
			{ title: "Pricing", body: "Free." },
			user,
		);
		await service.createNote(
			film,
			{ title: "Launch", body: "See [[Pricing]] and [[Pricing#Tiers|tiers]]." },
			user,
		);
		await service.createNote(
			"shared",
			{ title: "Roadmap", properties: { ref: "[[Pricing]]" } },
			user,
		);
		// Games overrides Pricing, so its links point at its own note.
		await service.createNote(games, { title: "Pricing", body: "Games." }, user);
		await service.createNote(
			games,
			{ title: "Plan", body: "Read [[Pricing]]." },
			user,
		);
		await service.updateNote("global", "Pricing", { title: "Plans" }, user);
		expect((await service.getNote(film, "Launch")).body).toBe(
			"See [[Plans]] and [[Plans#Tiers|tiers]].",
		);
		expect((await service.getNote("shared", "Roadmap")).properties.ref).toBe(
			"[[Plans]]",
		);
		expect((await service.getNote(games, "Plan")).body).toBe(
			"Read [[Pricing]].",
		);
		expect(await service.unresolved(film)).toEqual([]);
	});

	it("files proposals per workspace and refuses changes to inherited notes", async () => {
		const { service } = synapse();
		await service.createNote(
			"global",
			{ title: "Pricing", body: "Free tier." },
			user,
		);
		await expect(
			service.propose(
				agent,
				{
					action: "update",
					title: "Pricing",
					body: "Paid.",
					reason: "Change.",
				},
				film,
			),
		).rejects.toMatchObject({ statusCode: 409 });
		const proposal = await service.propose(
			agent,
			{
				action: "create",
				title: "Pricing",
				body: "Film pricing.",
				reason: "Film differs.",
			},
			film,
		);
		expect(proposal).toMatchObject({ space: "shared", baseRevision: null });
		expect(
			(await service.listProposals({ space: film })).map((item) => item.id),
		).toEqual([proposal.id]);
		expect(await service.listProposals({ space: "shared" })).toEqual([]);
		expect(await service.listProposals({ space: games })).toEqual([]);
		// Another workspace's reviewer cannot see or decide it.
		await expect(
			service.decideProposal(proposal.id, { decision: "approve" }, user, games),
		).rejects.toMatchObject({ statusCode: 404 });
		const approved = await service.decideProposal(
			proposal.id,
			{ decision: "approve" },
			user,
			film,
		);
		expect(approved).toMatchObject({ status: "approved", space: "shared" });
		expect((await service.getNote(film, "Pricing")).body).toBe("Film pricing.");
		expect((await service.getNote(games, "Pricing")).body).toBe("Free tier.");
	});
});
