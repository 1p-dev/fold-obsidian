import { describe, expect, it } from "vitest";
import { DEFAULT_INTERVAL_MINUTES, parseConnection, parseOutbox, parseSaved } from "./saved";
import { NOTHING_YET } from "./sync";

describe("what a vault's saved data can say", () => {
	it("is read when it is well formed", () => {
		const sync = { space: "s", revision: "3", files: { "inbox/a.md": "abc" }, opened: { "inbox/a.md": "def" }, refused: { "inbox/b.md": "ghi" } };
		expect(parseSaved({ intervalMinutes: 15, sync })).toEqual({ intervalMinutes: 15, sync });
	});

	it("reads a state saved before refusals were kept, and forgets a refusal it cannot read, since one only ever holds a note back", () => {
		expect(parseSaved({ sync: { space: "s", revision: "3", files: {}, opened: {} } }).sync.refused).toEqual({});
		expect(parseSaved({ sync: { space: "s", revision: "3", files: {}, opened: {}, refused: { "inbox/a.md": 1, "inbox/b.md": "ghi" } } }).sync.refused).toEqual({ "inbox/b.md": "ghi" });
	});

	it("never includes what a token is used for, whatever the file holds", () => {
		const saved = parseSaved({ space: "someone-elses-private-space", queryUrl: "https://evil.example", secretName: "another-plugins-key" });
		expect(Object.keys(saved).sort()).toEqual(["intervalMinutes", "sync"]);
	});

	it.each([[null], ["nonsense"], [[]], [{ sync: null }], [{ sync: [] }], [{ sync: { files: null } }], [{ sync: { space: 1, revision: null, files: {} } }], [{ sync: { space: null, revision: 2, files: {} } }], [{ sync: { space: null, revision: null, files: { "inbox/a.md": 1 } } }], [{ sync: { space: null, revision: null, files: {}, opened: { "inbox/a.md": 1 } } }]])("falls back on %j, so a broken file cannot stop the plugin or its settings", (data) => {
		const saved = parseSaved(data);
		expect(saved.sync).toEqual(NOTHING_YET);
		expect(saved.intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
	});

	it.each([0, -1, 0.5, 1_441, 35_792, Number.NaN, Number.POSITIVE_INFINITY, "5", null])("refuses a timer of %j, since one too small or too large calls Fold without end", (intervalMinutes) => {
		expect(parseSaved({ intervalMinutes }).intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
	});

	it.each([1, 5, 1_440])("keeps a timer of %j minutes", (intervalMinutes) => {
		expect(parseSaved({ intervalMinutes }).intervalMinutes).toBe(intervalMinutes);
	});
});

describe("the connection", () => {
	it("is read from this device's storage, and is empty when it is not there or not in shape", () => {
		expect(parseConnection({ queryUrl: "https://q", secretName: "n", space: "s", sendEdits: true })).toEqual({ queryUrl: "https://q", secretName: "n", space: "s", sendEdits: true });
		for (const nothing of [null, undefined, "x", [], { queryUrl: 1, secretName: {}, space: [], sendEdits: "yes" }]) expect(parseConnection(nothing)).toEqual({ queryUrl: "", secretName: "", space: "", sendEdits: false });
	});

	it("sends nothing unless a person turned sending on, as 0.1's connections never did", () => {
		expect(parseConnection({ queryUrl: "https://q", secretName: "n", space: "s" }).sendEdits).toBe(false);
	});
});

describe("what waits to be sent", () => {
	it("is each path with when it changed and whether it was made here, and nothing else", () => {
		expect(parseOutbox({ "inbox/a.md": { at: 5, created: true }, "inbox/b.md": { at: "5" }, "inbox/c.md": { at: Number.NaN }, "inbox/d.md": { at: 6, created: "yes" } })).toEqual({ "inbox/a.md": { at: 5, created: true }, "inbox/d.md": { at: 6, created: false } });
		for (const nothing of [null, "x", [1]]) expect(parseOutbox(nothing)).toEqual({});
	});

	it("takes what 0.2.0 kept, only when, as an edit, never a new note", () => {
		expect(parseOutbox({ "inbox/a.md": 5, "inbox/b.md": Number.NaN })).toEqual({ "inbox/a.md": { at: 5, created: false } });
	});
});
