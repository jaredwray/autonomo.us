import { render } from "@testing-library/react";
import { expect, it } from "vitest";
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
