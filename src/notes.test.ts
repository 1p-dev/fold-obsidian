import { describe, expect, it } from "vitest";
import { asOpened, editCopyPath, isNote, isSafe, localForm } from "./notes";

describe("what a note is", () => {
	it("is Markdown in those folders, in any case", () => {
		for (const path of ["inbox/a.md", "managed/b/c.MD", "inbox/a.markdown", "managed/a.mdx"]) expect(isNote(path), path).toBe(true);
		for (const path of ["inbox/a.txt", "inbox/.md", "inbox/md", "reference/a.md", "a.md", "inboxes/a.md", "memory/inbox/a.md"]) expect(isNote(path), path).toBe(false);
	});
});

describe("a safe path", () => {
	it("keeps names in every script, and the joiners they need", () => {
		for (const path of ["inbox/Ångström notes/über.md", "managed/日本語/メモ.md", "inbox/می‌خواهم.md", "inbox/हिन्दी.md", "inbox/שלום.md", "inbox/🌹.md", "managed/a b/c d.md", "inbox/%2e%2e.md", "inbox/a#b.md", "inbox/console.md", "inbox/com.md"]) {
			expect(isSafe(path), path).toBe(true);
		}
	});
});

describe("a note as Obsidian leaves it once opened", () => {
	const form = (text: string) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(asOpened(new TextEncoder().encode(text)));

	it("has no byte order mark at its start, and every line ending is a line feed", () => {
		expect(form("\ufeff# A\r\nb\rc\n")).toBe("# A\nb\nc\n");
	});

	it("keeps what a person would call the text, a byte order mark inside it included", () => {
		expect(form("a\ufeffb, caf\u00e9, cafe\u0301, \u{1f339}")).toBe("a\ufeffb, caf\u00e9, cafe\u0301, \u{1f339}");
		expect(form("")).toBe("");
	});
});

describe("a path on disk", () => {
	it("takes the form Obsidian's normalizePath gives it", () => {
		expect(localForm("inbox/a\u00a0b\u202fc.md")).toBe("inbox/a b c.md");
		expect(localForm("inbox/cafe\u0301.md")).toBe("inbox/caf\u00e9.md");
		expect(localForm("inbox/a\u2003b.md")).toBe("inbox/a\u2003b.md");
	});
});

describe("where a person's edit goes", () => {
	it("stays a note in the same folder, numbered after the first", () => {
		expect(editCopyPath("managed/a/rye.md", 1)).toBe("managed/a/rye (local edit).md");
		expect(editCopyPath("managed/a/rye.md", 2)).toBe("managed/a/rye (local edit 2).md");
		expect(isSafe(editCopyPath("inbox/rye.v2.md", 1))).toBe(true);
	});
});
