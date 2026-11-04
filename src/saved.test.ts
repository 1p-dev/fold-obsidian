import { describe, expect, it } from "vitest";
import { DEFAULT_INTERVAL_MINUTES, parseConnection, parseSaved } from "./saved";
import { NOTHING_YET } from "./sync";

describe("what a vault's saved data can say", () => {
	it("is read when it is well formed", () => {
		const sync = { space: "s", revision: "3", files: { "inbox/a.md": "abc" }, opened: { "inbox/a.md": "def" } };
		expect(parseSaved({ intervalMinutes: 15, sync })).toEqual({ intervalMinutes: 15, sync });
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
		expect(parseConnection({ queryUrl: "https://q", secretName: "n", space: "s" })).toEqual({ queryUrl: "https://q", secretName: "n", space: "s" });
		for (const nothing of [null, undefined, "x", [], { queryUrl: 1, secretName: {}, space: [] }]) expect(parseConnection(nothing)).toEqual({ queryUrl: "", secretName: "", space: "" });
	});
});
