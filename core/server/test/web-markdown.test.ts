import { describe, expect, it } from "vitest";
import {
	decodeEntities,
	htmlToMarkdown,
	truncateText,
} from "../src/web/markdown.js";

const base = "https://example.com/docs/page.html";
const md = (html: string) => htmlToMarkdown(html, base);

describe("htmlToMarkdown", () => {
	it("keeps headings, paragraphs, and inline emphasis", () => {
		expect(
			md(
				"<h1>Title</h1><p>Some <strong>bold</strong> and <em>soft</em> text.</p><h2>Next</h2><p>More</p>",
			),
		).toBe("# Title\n\nSome **bold** and *soft* text.\n\n## Next\n\nMore");
	});

	it("puts the title first when the page has no h1", () => {
		expect(
			md(
				"<html><head><title>My &amp; Page</title></head><body><p>Body</p></body></html>",
			),
		).toBe("# My & Page\n\nBody");
		expect(
			md(
				"<html><head><title>Ignored</title></head><body><h1>Own</h1></body></html>",
			),
		).toBe("# Own");
	});

	it("drops scripts, styles, navigation, and other chrome", () => {
		const html = `<html><head><style>p { color: red }</style><script>document.write("<p>bad</p>")</script></head>
			<body><nav><a href="/">Home</a></nav><p>Kept</p><aside>Ad</aside><noscript>Enable JS</noscript>
			<svg><text>chart</text></svg><footer>Footer</footer><template><p>tmpl</p></template></body></html>`;
		expect(md(html)).toBe("Kept");
	});

	it("closes a head left open, as browsers do", () => {
		expect(
			md("<html><head><title>T</title><body><h1>Hi</h1><p>There</p>"),
		).toBe("# Hi\n\nThere");
	});

	it("resolves links and drops unsafe or empty ones", () => {
		expect(
			md(
				'<p><a href="../guide">Guide</a> <a href="https://other.org/x?y=1">Other</a> <a href="javascript:alert(1)">Click</a> <a href="#top">Top</a> <a href="/empty"></a> <a href="mailto:a@b.c">Mail</a></p>',
			),
		).toBe(
			"[Guide](https://example.com/guide) [Other](https://other.org/x?y=1) Click Top [Mail](mailto:a@b.c)",
		);
	});

	it("keeps images with alt text only", () => {
		expect(
			md(
				'<p><img src="/a.png" alt="A chart"> <img src="/b.png"> <img src="data:image/png;base64,AAA" alt="inline"></p>',
			),
		).toBe("![A chart](https://example.com/a.png)");
	});

	it("writes nested lists", () => {
		expect(
			md(
				"<ul><li>One</li><li>Two<ul><li>Two A</li><li>Two B</li></ul></li><li>Three</li></ul><ol><li>First<li>Second</ol>",
			),
		).toBe(
			"- One\n- Two\n  - Two A\n  - Two B\n- Three\n\n1. First\n2. Second",
		);
	});

	it("does not leave a bullet empty when the item holds a paragraph", () => {
		expect(md("<ul><li><p>Para item</p></li><li>Plain</li></ul>")).toBe(
			"- Para item\n- Plain",
		);
	});

	it("keeps preformatted code and inline code", () => {
		expect(
			md(
				"<p>Run <code>npm test</code>:</p><pre><code>\nconst a = 1;\n  if (a) {\n    go();\n  }\n</code></pre><p>Done</p>",
			),
		).toBe(
			"Run `npm test`:\n\n```\nconst a = 1;\n  if (a) {\n    go();\n  }\n```\n\nDone",
		);
	});

	it("writes blockquotes and rules", () => {
		expect(
			md("<blockquote><p>Quoted</p><p>Twice</p></blockquote><hr><p>After</p>"),
		).toBe("> Quoted\n>\n> Twice\n\n---\n\nAfter");
	});

	it("writes tables as pipe tables", () => {
		expect(
			md(
				"<table><tr><th>Name</th><th>Price</th></tr><tr><td>Basic</td><td>$1</td></tr><tr><td>Pro<br>plan</td><td>$5</td></tr></table>",
			),
		).toBe(
			"| Name | Price |\n| --- | --- |\n| Basic | $1 |\n| Pro plan | $5 |",
		);
	});

	it("prefers the main content when the page marks it", () => {
		expect(
			md(
				"<body><div>Header junk</div><main><h1>Article</h1><p>Body</p></main><div>Footer junk</div></body>",
			),
		).toBe("# Article\n\nBody");
		expect(
			md("<body><div>Junk</div><article><p>Story</p></article></body>"),
		).toBe("Story");
	});

	it("collapses whitespace and keeps at most one blank line", () => {
		expect(md("<p>  a \n\t b  </p>\n\n\n<div></div><div></div><p>c</p>")).toBe(
			"a b\n\nc",
		);
	});

	it("keeps a stray < that is not a tag", () => {
		expect(md("<p>1 < 2 and 3 <= 4</p>")).toBe("1 < 2 and 3 <= 4");
	});

	it("handles quoted attributes that contain >", () => {
		expect(md('<p><a title="a > b" href="/x">X</a></p>')).toBe(
			"[X](https://example.com/x)",
		);
	});

	it("does not put spaces inside emphasis markers", () => {
		expect(md("<p>Say <b> loud </b>now</p>")).toBe("Say **loud** now");
	});

	it("stays fast on hostile input", () => {
		const started = performance.now();
		md("<".repeat(200_000));
		md("<div>".repeat(100_000));
		md(`${"<b>".repeat(50_000)}x${"</b>".repeat(50_000)}`);
		md(`<a href="x">${"<li>".repeat(50_000)}`);
		md("</span>".repeat(100_000));
		md(`<p>${"&amp;".repeat(100_000)}</p>`);
		md(`<a ${'b="1" '.repeat(50_000)}`);
		md(`<table>${"<tr><td>x".repeat(30_000)}`);
		expect(performance.now() - started).toBeLessThan(3000);
	});
});

describe("decodeEntities", () => {
	it("decodes named and numeric references", () => {
		expect(
			decodeEntities(
				"&lt;b&gt; &amp; &quot;x&quot; &#39; &#x1F600; &copy; &nbsp;|",
			),
		).toBe('<b> & "x" \' 😀 ©  |');
	});

	it("leaves unknown or malformed references alone", () => {
		expect(decodeEntities("&unknown; & &#xZZ; &#;")).toBe(
			"&unknown; & &#xZZ; &#;",
		);
	});

	it("accepts legacy references without a semicolon", () => {
		expect(decodeEntities("a &amp b &lt c")).toBe("a & b < c");
	});

	it("replaces references to invalid code points", () => {
		expect(decodeEntities("&#0; &#xD800; &#1114112;")).toBe("� � �");
	});
});

describe("truncateText", () => {
	it("returns short text unchanged", () => {
		expect(truncateText("short", 100)).toEqual({
			content: "short",
			truncated: false,
		});
	});

	it("cuts at a paragraph break near the end", () => {
		const text = `${"a".repeat(90)}\n\n${"b".repeat(50)}`;
		expect(truncateText(text, 100)).toEqual({
			content: "a".repeat(90),
			truncated: true,
		});
	});

	it("falls back to a space, then a hard cut", () => {
		expect(
			truncateText(`${"a".repeat(85)} ${"b".repeat(50)}`, 100).content,
		).toBe("a".repeat(85));
		expect(truncateText("x".repeat(200), 100).content).toBe("x".repeat(100));
	});

	it("does not split a surrogate pair", () => {
		const text = `${"x".repeat(99)}😀tail`;
		expect(truncateText(text, 100).content).toBe("x".repeat(99));
	});
});
