import { describe, expect, it } from "vitest";
import {
	extractCategories,
	extractLinks,
	extractTags,
	parseMarkdown,
	plainText,
	renderFrontmatter,
	renderMarkdown,
	rewriteLinks,
	rewritePropertyLinks,
	snippet,
	titleProblem,
	validateProperties,
} from "../src/synapse/markdown.js";
import { crc32, zipStore } from "../src/synapse/zip.js";

describe("wikilinks", () => {
	it("reads every link form, dedupes case-insensitively, and keeps first spelling", () => {
		const body = [
			"Met [[Ada Lovelace]] and [[ada lovelace|Ada]] about [[Analytical Engine#Design]].",
			"See [[Notes#^block1]] and ![[Diagram]] plus [[References/Charles Babbage]] and [[Old Note.md]].",
			"Attachments: ![[photo.jpg]] [[spec.PDF]] but [[Node.js]] and [[autonomo.us]] are notes.",
			"[[#Heading only]] [[ ]] [[|alias only]]",
		].join("\n");
		expect(extractLinks([body])).toEqual([
			"Ada Lovelace",
			"Analytical Engine",
			"Notes",
			"Diagram",
			"Charles Babbage",
			"Old Note",
			"Node.js",
			"autonomo.us",
		]);
	});

	it("ignores links inside fenced blocks, tilde fences, and inline code", () => {
		const body = [
			"Real [[One]] link.",
			"```md",
			"[[Fenced]]",
			"```",
			"~~~",
			"[[Tilde]]",
			"~~~",
			"Inline `[[Code]]` and ``[[Double `tick` code]]`` but [[Two]] stays.",
			"````",
			"```",
			"[[Nested fence]]",
			"```",
			"````",
			"Unclosed `[[Three]] stays a link",
			"```",
			"[[Unclosed fence]]",
		].join("\n");
		expect(extractLinks([body])).toEqual(["One", "Two", "Three"]);
	});

	it("takes links from property strings and lists", () => {
		expect(
			extractLinks(["[[Body]]", "[[People]]", "see [[Org Chart|chart]]"]),
		).toEqual(["Body", "People", "Org Chart"]);
		expect(
			extractCategories({
				categories: ["[[People]]", "[[Projects]]"],
				org: [],
			}),
		).toEqual(["People", "Projects"]);
		expect(extractCategories({ categories: "[[Evergreen]]" })).toEqual([
			"Evergreen",
		]);
		expect(extractCategories({})).toEqual([]);
	});
});

describe("tags", () => {
	it("merges the tags property with inline tags outside code", () => {
		const body = [
			"# Heading is not a tag",
			"#Intro tag at line start and #nested/Child here, #_under and #with-dash, #2026 digits only, #v2 ok.",
			"email#notatag and `#code` and",
			"```",
			"#fenced",
			"```",
			"#🌲evergreen tag with emoji #1/2 digits",
		].join("\n");
		expect(
			extractTags(body, { tags: ["#Clippings", "daily", " Daily "] }),
		).toEqual([
			"clippings",
			"daily",
			"intro",
			"nested/child",
			"_under",
			"with-dash",
			"v2",
			"🌲evergreen",
			"1/2",
		]);
		expect(extractTags("", { tags: "Journal" })).toEqual(["journal"]);
		expect(extractTags("", { tags: null })).toEqual([]);
	});
});

describe("titles", () => {
	it("applies Obsidian's file name rules", () => {
		expect(titleProblem("Ada Lovelace")).toBeNull();
		expect(titleProblem("Node.js")).toBeNull();
		expect(titleProblem("2026-11-08")).toBeNull();
		expect(titleProblem("")).toMatch(/required/);
		expect(titleProblem(" padded")).toMatch(/whitespace/);
		expect(titleProblem("padded ")).toMatch(/whitespace/);
		expect(titleProblem(".hidden")).toMatch(/period/);
		for (const char of [
			"\\",
			"/",
			":",
			"*",
			"?",
			'"',
			"<",
			">",
			"|",
			"#",
			"^",
			"[",
			"]",
		])
			expect(titleProblem(`a${char}b`), char).toMatch(/cannot contain/);
		expect(titleProblem("tab\there")).toMatch(/control/);
		expect(titleProblem("x".repeat(200))).toBeNull();
		expect(titleProblem("x".repeat(201))).toMatch(/200/);
		expect(titleProblem(42)).toMatch(/required/);
	});
});

describe("properties", () => {
	it("validates keys, shapes, and limits", () => {
		expect(
			validateProperties({
				org: ["[[ACME]]"],
				role: null,
				rating: 6,
				active: true,
				"created at": "2026-11-08",
				"a.b-c_d": "x",
			}),
		).toEqual({
			org: ["[[ACME]]"],
			role: null,
			rating: 6,
			active: true,
			"created at": "2026-11-08",
			"a.b-c_d": "x",
		});
		expect(() => validateProperties([])).toThrow(/object/);
		expect(() => validateProperties({ "bad key!": 1 })).toThrow(/Property key/);
		expect(() => validateProperties({ "-leading": 1 })).toThrow(/Property key/);
		expect(() =>
			validateProperties(JSON.parse('{"__proto__": ["x"]}')),
		).toThrow(/Property key/);
		expect(() => validateProperties({ nested: { a: 1 } })).toThrow(/must be/);
		expect(() => validateProperties({ list: [1] })).toThrow(/list of strings/);
		expect(() => validateProperties({ big: "x".repeat(2001) })).toThrow(/2000/);
		expect(() =>
			validateProperties({ list: Array.from({ length: 101 }, () => "x") }),
		).toThrow(/100/);
		expect(() => validateProperties({ nan: Number.NaN })).toThrow(/finite/);
		expect(() =>
			validateProperties(
				Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 1])),
			),
		).toThrow(/50/);
	});
});

describe("frontmatter", () => {
	it("renders the documented format", () => {
		expect(
			renderFrontmatter({
				categories: ["[[People]]"],
				org: [],
				role: "Researcher",
				created: "2026-11-08",
				rating: 6,
				active: true,
				email: null,
			}),
		).toBe(
			[
				"---",
				"categories:",
				'  - "[[People]]"',
				"org: []",
				"role: Researcher",
				"created: 2026-11-08",
				"rating: 6",
				"active: true",
				"email:",
				"---",
				"",
			].join("\n"),
		);
		expect(renderFrontmatter({})).toBe("");
		expect(renderMarkdown({}, "# Body")).toBe("# Body");
	});

	it("round-trips tricky strings and every value kind", () => {
		const properties = {
			plain: "Hello world",
			date: "2026-11-08",
			numberish: "42",
			decimalish: "3.14",
			negative: "-1",
			boolish: "true",
			nullish: "null",
			tilde: "~",
			colon: "key: value",
			hash: "a #comment",
			nohash: "a#b",
			leadingSpace: " padded",
			trailingSpace: "padded ",
			dash: "- item",
			bracket: "[not a list]",
			brace: "{not a map}",
			quote: 'say "hi"',
			apostrophe: "it's",
			backtick: "`code`",
			at: "@handle",
			percent: "%20",
			star: "*bold*",
			bang: "!important",
			pipe: "| cell",
			gt: "> quote",
			amp: "&ref",
			question: "?",
			comma: ",a",
			unicode: "Zürich 🌲",
			newline: "two\nlines",
			tab: "a\tb",
			empty: "",
			link: "[[Ada]]",
			list: ["[[People]]", "plain", "42", "true", "", "x: y", "a, b"],
			emptyList: [],
			integer: 7,
			decimal: 2.5,
			negativeNumber: -3,
			yes: true,
			no: false,
			nothing: null,
		};
		const markdown = renderMarkdown(properties, "Body text\n\n- more");
		const parsed = parseMarkdown(markdown);
		expect(parsed.properties).toEqual(properties);
		expect(parsed.body).toBe("Body text\n\n- more");
		expect(parseMarkdown(renderMarkdown(properties, "")).body).toBe("");
	});

	it("reads the documented YAML subset", () => {
		const parsed = parseMarkdown(
			[
				"---",
				"title: Plain text",
				'quoted: "line\\nbreak"',
				"single: 'it''s'",
				"nothing:",
				"explicit: null",
				"tilde: ~",
				"empty: []",
				'flow: [a, "b, c", 3, true]',
				"block:",
				"  - one",
				'  - "two"',
				"  - 4",
				"  - false",
				"int: 12",
				"float: 1.5",
				"neg: -2",
				"date: 2026-11-08",
				"yes: true",
				"no: false",
				"# a comment",
				"",
				"commented: value # trailing comment",
				"template: {{date}}",
				"---",
				"Body",
				"---",
				"not frontmatter",
			].join("\n"),
		);
		expect(parsed.properties).toEqual({
			title: "Plain text",
			quoted: "line\nbreak",
			single: "it's",
			nothing: null,
			explicit: null,
			tilde: null,
			empty: [],
			flow: ["a", "b, c", "3", "true"],
			block: ["one", "two", "4", "false"],
			int: 12,
			float: 1.5,
			neg: -2,
			date: "2026-11-08",
			yes: true,
			no: false,
			commented: "value",
			template: "{{date}}",
		});
		expect(parsed.body).toBe("Body\n---\nnot frontmatter");
		expect(parseMarkdown("No frontmatter\n---\nstill body")).toEqual({
			properties: {},
			body: "No frontmatter\n---\nstill body",
		});
		expect(parseMarkdown("---\r\nkey: v\r\n---\r\nbody")).toEqual({
			properties: { key: "v" },
			body: "body",
		});
		expect(parseMarkdown(" ---\nkey: v\n---\n").properties).toEqual({});
	});

	it("round-trips a body that starts with a horizontal rule", () => {
		const body = "---\n\nSome text\n\n---\nmore";
		const file = renderMarkdown({}, body);
		expect(parseMarkdown(file)).toEqual({ properties: {}, body });
		expect(renderMarkdown({}, "plain")).toBe("plain");
		// Bodies stored through the API may keep Windows or old Mac line endings.
		for (const eol of ["\r\n", "\r"]) {
			const raw = `---${eol}Some text`;
			expect(parseMarkdown(renderMarkdown({}, raw))).toEqual({
				properties: {},
				body: "---\nSome text",
			});
		}
	});

	it("reads what Obsidian and older spaces write", () => {
		expect(parseMarkdown("\uFEFF---\nrole: Lead\n---\nBody")).toEqual({
			properties: { role: "Lead" },
			body: "Body",
		});
		expect(parseMarkdown("--- \nrole: Lead\n---  \nBody")).toEqual({
			properties: { role: "Lead" },
			body: "Body",
		});
		expect(
			parseMarkdown("---\ncategories: [[People]]\n---\n").properties,
		).toEqual({
			categories: ["[[People]]"],
		});
		expect(extractLinks(["| [[Ada Lovelace\\|Ada]] |"])).toEqual([
			"Ada Lovelace",
		]);
	});

	it("parses long frontmatter lines in linear time", () => {
		const started = performance.now();
		expect(() => parseMarkdown(`---\nx${" ".repeat(200_000)}y\n---\n`)).toThrow(
			/key: value/,
		);
		expect(
			parseMarkdown(`---\nnote: ${"word ".repeat(40_000)}\n---\n`).properties
				.note,
		).toHaveLength(199_999);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("rejects unsupported YAML and names the line", () => {
		const attempt = (lines: string[]) => () =>
			parseMarkdown(["---", ...lines, "---", "body"].join("\n"));
		expect(attempt(["nested:", "  key: value"])).toThrow(
			/Nested mappings.*line 3/,
		);
		expect(attempt(["block: |", "  text"])).toThrow(/Block scalars.*line 2/);
		expect(attempt(["folded: >", "  text"])).toThrow(/Block scalars.*line 2/);
		expect(attempt(["anchor: &a value"])).toThrow(/Anchors.*line 2/);
		expect(attempt(["alias: *a"])).toThrow(/Anchors.*line 2/);
		expect(attempt(["tagged: !!str value"])).toThrow(/tags.*line 2/);
		expect(attempt(["map: {a: 1}"])).toThrow(/Nested mappings.*line 2/);
		expect(attempt(["list: [[a], b]"])).toThrow(/Nested collections.*line 2/);
		expect(attempt(["open: [a, b"])).toThrow(/Unterminated flow list.*line 2/);
		expect(attempt(['open: "abc'])).toThrow(
			/Unterminated double-quoted.*line 2/,
		);
		expect(attempt(["open: 'abc"])).toThrow(
			/Unterminated single-quoted.*line 2/,
		);
		expect(attempt(["ok: 1", "- stray item"])).toThrow(/List item.*line 3/);
		expect(attempt(["bad key!: 1"])).toThrow(/Invalid property key.*line 2/);
		expect(attempt(["__proto__: [x]"])).toThrow(/Invalid property key.*line 2/);
		expect(attempt(["dup: 1", "dup: 2"])).toThrow(/Duplicate.*line 3/);
		expect(attempt(["no colon here"])).toThrow(/key: value.*line 2/);
		expect(() => parseMarkdown("---\nkey: value\nbody without end")).toThrow(
			/never closed.*line 1/,
		);
	});
});

describe("rename rewrite", () => {
	it("rewrites every casing and keeps alias, heading, block, and embed", () => {
		const body = [
			"See [[Old]], [[old|the old one]], [[OLD#Heading]], [[Old#^b1|alias]], ![[Old]].",
			"[[Old.md]] and [[folder/Old]] too, but not [[Older]] or `[[Old]]`.",
			"```",
			"[[Old]] in code stays",
			"```",
		].join("\n");
		expect(rewriteLinks(body, "Old", "New")).toBe(
			[
				"See [[New]], [[New|the old one]], [[New#Heading]], [[New#^b1|alias]], ![[New]].",
				"[[New]] and [[New]] too, but not [[Older]] or `[[Old]]`.",
				"```",
				"[[Old]] in code stays",
				"```",
			].join("\n"),
		);
		expect(
			rewritePropertyLinks(
				{
					categories: ["[[old]]", "[[Other]]"],
					note: "see [[Old|x]]",
					n: 1,
					e: null,
				},
				"Old",
				"New",
			),
		).toEqual({
			categories: ["[[New]]", "[[Other]]"],
			note: "see [[New|x]]",
			n: 1,
			e: null,
		});
	});
});

describe("snippets", () => {
	it("flattens Markdown and centers on the first match", () => {
		expect(plainText("# Title\n\nSee [[A|b]] and [[C#h]] and ![[D]] `x`")).toBe(
			"Title See b and C and D x",
		);
		const body = `${"word ".repeat(50)}needle in the haystack ${"tail ".repeat(50)}`;
		const found = snippet(body, ["needle"]);
		expect(found).toContain("needle");
		expect(found.startsWith("…")).toBe(true);
		expect(found.endsWith("…")).toBe(true);
		expect(found.length).toBeLessThanOrEqual(170);
		expect(snippet("short body", ["missing"])).toBe("short body");
		expect(snippet("x".repeat(400))).toBe(`${"x".repeat(160)}…`);
		expect(snippet("")).toBe("");
	});
});

describe("zip", () => {
	it("computes CRC-32 and writes a store-only archive with UTF-8 names", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array())).toBe(0);
		const bytes = zipStore(
			[
				{ path: "Zürich.md", content: "hello" },
				{ path: "Daily/2026-11-08.md", content: "" },
			],
			new Date("2026-11-08T10:20:30Z"),
		);
		const view = new DataView(bytes.buffer);
		expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
		expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
		expect(view.getUint16(8, true)).toBe(0);
		expect(view.getUint32(14, true)).toBe(
			crc32(new TextEncoder().encode("hello")),
		);
		const text = new TextDecoder().decode(bytes);
		expect(text).toContain("Zürich.md");
		expect(text).toContain("Daily/2026-11-08.md");
		// End of central directory: two entries, signature at the tail.
		const end = bytes.length - 22;
		expect(view.getUint32(end, true)).toBe(0x06054b50);
		expect(view.getUint16(end + 10, true)).toBe(2);
		expect(
			view.getUint32(end + 16, true) + view.getUint32(end + 12, true),
		).toBe(end);
	});
});
