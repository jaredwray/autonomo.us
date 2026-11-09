import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { importBatches } from "../src/brain-files.js";
import {
	MAX_NESTING,
	parseWikilink,
	renderMarkdown,
} from "../src/brain-markdown.js";

const options = { hrefFor: (title: string) => `#${title}`, onNavigate() {} };

it("parses wikilinks the way the server does", () => {
	expect(parseWikilink("Node.js")?.title).toBe("Node.js");
	expect(parseWikilink("autonomo.us|the gateway")).toMatchObject({
		title: "autonomo.us",
		label: "the gateway",
	});
	expect(parseWikilink("References/Ada Lovelace.md#Early life")).toMatchObject({
		title: "Ada Lovelace",
		fragment: "#Early life",
	});
	expect(parseWikilink("photo.jpg", true)).toBeNull();
	expect(parseWikilink("Board.canvas")).toBeNull();
	expect(parseWikilink(" | alias")).toBeNull();
});

it("renders deeply nested quotes and lists as text past the nesting limit", () => {
	const quotes = render(
		<div>{renderMarkdown(`${">".repeat(100_000)} deepest`, options)}</div>,
	);
	expect(quotes.container.querySelectorAll("blockquote")).toHaveLength(
		MAX_NESTING,
	);
	expect(quotes.container.textContent).toContain("deepest");
	quotes.unmount();

	const lines = Array.from(
		{ length: 2000 },
		(_, level) => `${"  ".repeat(level)}- item ${level}`,
	);
	const lists = render(<div>{renderMarkdown(lines.join("\n"), options)}</div>);
	expect(lists.container.querySelectorAll("ul")).toHaveLength(MAX_NESTING);
	expect(lists.container.textContent).toContain("item 1999");
});

it("renders pathological lines in linear time", () => {
	const inputs = [
		`# a${" ".repeat(100_000)}x`,
		`text\n# a${" ".repeat(100_000)}x`,
		`# ${"#".repeat(50_000)}x`,
		"[".repeat(100_000),
		"[[".repeat(50_000),
		"`".repeat(100_000),
		`| a |\n|---${" ".repeat(100_000)}x`,
		"https://.".repeat(11_000),
		// Unmatched runs of every length up to 447: about 100,000 characters.
		Array.from({ length: 447 }, (_, index) => "`".repeat(index + 1)).join("x"),
	];
	for (const input of inputs) {
		const started = performance.now();
		render(<div>{renderMarkdown(input, options)}</div>).unmount();
		expect(performance.now() - started, input.slice(0, 12)).toBeLessThan(1500);
	}
});

it("follows CommonMark for headings, closing hashes, and fences", () => {
	render(
		<div>
			{renderMarkdown(
				[
					"# Top",
					"## C#",
					"### Closed ###",
					"####### seven",
					"```inline code```",
					"",
					"After [[Link]].",
					"",
					"```ts",
					"const a = 1;",
					"```",
				].join("\n"),
				options,
			)}
		</div>,
	);
	expect(screen.getByRole("heading", { name: "Top" }).tagName).toBe("H3");
	expect(screen.getByRole("heading", { name: "C#" }).tagName).toBe("H4");
	expect(screen.getByRole("heading", { name: "Closed" }).tagName).toBe("H5");
	expect(screen.queryByRole("heading", { name: /seven/ })).toBeNull();
	expect(screen.getByRole("link", { name: "Link" })).toBeDefined();
	// Code spans may use any run length; links inside them stay text.
	render(
		<p>
			{renderMarkdown(`${"`".repeat(9)}[[Target]]${"`".repeat(9)}`, options)}
		</p>,
	);
	expect(screen.getByText("[[Target]]").tagName).toBe("CODE");
	expect(screen.queryByRole("link", { name: "Target" })).toBeNull();
	const blocks = document.querySelectorAll("pre");
	expect(blocks).toHaveLength(1);
	expect(blocks[0].dataset.language).toBe("ts");
	expect(parseWikilink("Ada Lovelace\\|Ada")).toMatchObject({
		title: "Ada Lovelace",
		label: "Ada",
	});
});

it("splits imports into requests the server accepts", () => {
	const file = (index: number, size = 10) => ({
		path: `Note ${index}.md`,
		content: "x".repeat(size),
	});
	const many = Array.from({ length: 1001 }, (_, index) => file(index));
	expect(importBatches(many).map((batch) => batch.length)).toEqual([
		500, 500, 1,
	]);
	const big = [file(1, 600), file(2, 600), file(3, 600)];
	expect(importBatches(big, 500, 1300).map((batch) => batch.length)).toEqual([
		2, 1,
	]);
	expect(importBatches([file(1, 5000)], 500, 1000)).toHaveLength(1);
	expect(importBatches([])).toEqual([]);
});
