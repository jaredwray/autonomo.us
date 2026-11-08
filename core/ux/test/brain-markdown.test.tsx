import { expect, it } from "vitest";
import { parseWikilink } from "../src/brain-markdown.js";

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
