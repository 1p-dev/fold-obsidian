import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "./api/mock";
import { foldClient, type Http } from "./fold";
import { sha256 } from "./hash";
import { NOTHING_YET, OTHER_SPACE, type SyncState, syncSpace } from "./sync";
import { FakeFold, MemoryStore, refusal } from "./test-support";

const SPACE = { space: "s" };
const QUERY = "https://query.fold.test";

async function round(fold: FakeFold, store: MemoryStore, state: SyncState = NOTHING_YET, force = false) {
	return syncSpace(fold, store, state, { ...SPACE, force });
}

/** The plugin's real client, through its real adapter, over the mock of Fold's API. */
function overTheMock(files: Record<string, string>) {
	const api = createMockApi({ spaces: [{ id: "s", organization: { id: "o", name: "O" }, access: "admin", files }] });
	const requests: string[] = [];
	const http: Http = async (request) => {
		requests.push(`${request.method} ${new URL(request.url).pathname}`);
		const answer = await api.handle(new Request(request.url, { method: request.method, headers: request.headers }));
		return { status: answer.status, headers: Object.fromEntries(answer.headers), arrayBuffer: await answer.arrayBuffer() };
	};
	return { api, requests, client: foldClient(QUERY, () => "a-token", http) };
}

// The plugin takes its timers from window, as Obsidian asks of a plugin so popout windows work; in Node that is the global scope.
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});

describe("what comes into the vault", () => {
	it("is a space's notes and nothing else, through the real client", async () => {
		const { client, requests } = overTheMock({
			"PURPOSE.md": "# S\n",
			"OVERVIEW.md": "An overview.\n",
			"inbox/new.md": "# New\n",
			"managed/roses.md": "# Roses\n",
			"managed/deep/soil.md": "# Soil\n",
			"reference/handbook.md": "# Handbook\n",
			"inbox/data.csv": "a,b\n",
		});
		const store = new MemoryStore();
		const { state, report } = await syncSpace(client, store, NOTHING_YET, SPACE);
		expect([...store.files.keys()].sort()).toEqual(["inbox/new.md", "managed/deep/soil.md", "managed/roses.md"]);
		expect(report).toMatchObject({ ran: true, complete: true, written: 3, notes: 3 });
		expect(state.revision).toBe("1");
		expect(Object.keys(state.files)).toHaveLength(3);
		// It never asked for anything else, and it only ever reads.
		expect(requests.filter((request) => request.includes("reference") || request.includes("PURPOSE") || request.includes("data.csv"))).toEqual([]);
		expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
	});

	it("is byte for byte, whatever a note holds", async () => {
		const text = "﻿# Title\r\n\r\ncafé, café, 🌹, 日本語\rlone\n\ttab\u0001 \r\n\r\nno final newline";
		const { client } = overTheMock({ "PURPOSE.md": "# S\n", "managed/odd.md": text });
		const store = new MemoryStore();
		await syncSpace(client, store, NOTHING_YET, SPACE);
		expect(store.files.get("managed/odd.md")).toEqual(new TextEncoder().encode(text));
	});

	it("is nothing at all from a space with no notes, which is an answer and not a fault", async () => {
		const fold = new FakeFold({ "PURPOSE.md": "# S\n", "reference/a.md": "# A\n" });
		const store = new MemoryStore();
		const { state, report } = await round(fold, store);
		expect(report).toMatchObject({ ran: true, complete: true, notes: 0, written: 0 });
		expect(report.stoppedBy).toBeUndefined();
		expect(store.files.size).toBe(0);
		expect(state.revision).toBe("1");
	});
});

describe("a path from Fold is hostile input", () => {
	it.each([
		"inbox/.obsidian/plugins/evil/main.md",
		"managed/.trash/a.md",
		"inbox/../.obsidian/app.md",
		"managed/../../secret.md",
		"inbox/./a.md",
		"inbox//a.md",
		"inbox/a\\..\\b.md",
		"inbox/a:b.md",
		"inbox/a*b.md",
		"inbox/a?b.md",
		'inbox/a"b.md',
		"inbox/a<b.md",
		"inbox/a|b.md",
		"inbox/CON.md",
		"managed/con.tar.md",
		"inbox/LPT1.md",
		"inbox/dir./a.md",
		"inbox/dir /a.md",
		"inbox/a\u0000.md",
		"inbox/a\nb.md",
		"inbox/a‮b.md",
		`inbox/${"a".repeat(260)}.md`,
	])("%j never reaches the disk or the network", async (path) => {
		const fold = new FakeFold({ [path]: "<script>evil</script>\n" });
		const store = new MemoryStore();
		const { state, report } = await round(fold, store);
		expect(store.log).toEqual([]);
		expect(fold.reads).toEqual([]);
		expect(report.blocked).toEqual([path]);
		// A note that can never come here does not hold the rest back.
		expect(report.complete).toBe(true);
		expect(state.files).toEqual({});
	});

	it.each([".obsidian/plugins/evil/main.js", ".obsidian/app.md", "../outside.md", "/etc/passwd.md", "reference/a.md", "system/settings.md", "memory/inbox/old.md", "Inbox/a.md", "inboxes/a.md", "DREAMS.md"])("%j is no note at all, so it is not even mentioned", async (path) => {
		const fold = new FakeFold({ [path]: "x\n" });
		const store = new MemoryStore();
		const { report } = await round(fold, store);
		expect(store.log).toEqual([]);
		expect(fold.reads).toEqual([]);
		expect(report).toMatchObject({ notes: 0, blocked: [], complete: true });
	});

	it("keeps two paths apart that one disk would treat as the same file", async () => {
		const fold = new FakeFold({ "inbox/Rye.md": "one\n", "inbox/rye.md": "two\n", "managed/café.md": "three\n", "managed/café.md": "four\n" });
		const store = new MemoryStore();
		const { report } = await round(fold, store);
		expect(store.files.size).toBe(2);
		expect(report.blocked).toHaveLength(2);
	});
});

describe("a path is judged as it will be on disk", () => {
	it.each(["inbox/dir\u00a0/a.md", "inbox/dir\u202f/a.md", "managed/\u00a0dir\u00a0/a.md"])("%j ends in a space once Obsidian writes it, so it stays out", async (path) => {
		const fold = new FakeFold({ [path]: "x\n" });
		const store = new MemoryStore();
		const { report } = await round(fold, store);
		expect(store.log).toEqual([]);
		expect(report.blocked).toEqual([path]);
	});

	it("keeps apart two names one file would hold, so removing one never takes the other", async () => {
		const fold = new FakeFold({ "inbox/a b.md": "same\n", "inbox/a\u00a0b.md": "same\n", "inbox/a\u202fb.md": "same\n" });
		const store = new MemoryStore();
		const { state, report } = await round(fold, store);
		expect(store.files.size).toBe(1);
		expect(report.blocked).toHaveLength(2);
		expect(Object.keys(state.files)).toEqual(["inbox/a b.md"]);
	});

	it("keeps the folder a vault already holds, so a newcomer spelling it differently cannot freeze the notes there", async () => {
		const fold = new FakeFold({ "managed/bread/rye.md": "rye\n", "managed/bread/oats.md": "oats\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		fold.notes = { "managed/Bread/spelt.md": "spelt\n", "managed/bread/rye.md": "rye, changed\n", "managed/bread/oats.md": "oats\n" };
		fold.served = "2";
		const { report } = await round(fold, store, first.state);
		expect(report.blocked).toEqual(["managed/Bread/spelt.md"]);
		expect(store.text("managed/bread/rye.md")).toBe("rye, changed\n");
		expect(store.files.has("managed/Bread/spelt.md")).toBe(false);
	});

	it("carries what it knows to the other spelling of a note a disk treats as one file, even when its text changed too", async () => {
		const fold = new FakeFold({ "managed/cafe\u0301.md": "first\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.log.length = 0;
		fold.notes = { "managed/caf\u00e9.md": "second\n" };
		fold.served = "2";
		const { state, report } = await round(fold, store, first.state);
		expect(report).toMatchObject({ blocked: [], trashed: 0, written: 1, editCopies: [] });
		expect(store.text("managed/caf\u00e9.md")).toBe("second\n");
		expect(Object.keys(state.files)).toEqual(["managed/caf\u00e9.md"]);
	});

	it("never takes the file another spelling still holds, when Fold removes one of the two", async () => {
		const fold = new FakeFold({ "inbox/a b.md": "same\n", "inbox/a\u00a0b.md": "same\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		fold.notes = { "inbox/a\u00a0b.md": "same\n" };
		fold.served = "2";
		const { report } = await round(fold, store, first.state);
		expect(report.trashed).toBe(0);
		expect(store.text("inbox/a b.md")).toBe("same\n");
	});

	it("treats a rename of case alone as a move, on a disk where they are two files", async () => {
		const fold = new FakeFold({ "inbox/Rye.md": "rye\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		fold.notes = { "inbox/rye.md": "rye\n" };
		fold.served = "2";
		const { report } = await round(fold, store, first.state);
		expect(report.trashed).toBe(1);
		expect([...store.files.keys()]).toEqual(["inbox/rye.md"]);
	});

	it("keeps out a note whose folder another note spells differently, which one disk would treat as one folder", async () => {
		const fold = new FakeFold({ "inbox/A/x.md": "x\n", "inbox/a/y.md": "y\n", "inbox/b/z.md": "z\n", "inbox/b/w.md": "w\n" });
		const store = new MemoryStore();
		const { state, report } = await round(fold, store);
		expect(report.blocked).toEqual(["inbox/a/y.md"]);
		expect(report.complete).toBe(true);
		expect(state.revision).toBe("1");
		expect(store.files.size).toBe(3);
	});

	it("keeps out a note whose path another note needs as a folder, whichever comes first", async () => {
		for (const notes of [{ "inbox/a.md": "file\n", "inbox/a.md/b.md": "under\n" }, { "inbox/a.md/b.md": "under\n", "inbox/a.md": "file\n" }]) {
			const store = new MemoryStore();
			const { report } = await round(new FakeFold(notes), store);
			expect(store.files.size).toBe(1);
			expect(report.blocked).toHaveLength(1);
		}
	});
});

describe("a vault holds one space", () => {
	it("changes nothing when asked to sync another, so one space's list can never remove another's notes", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const store = new MemoryStore();
		const first = await syncSpace(fold, store, NOTHING_YET, { space: "first" });
		store.log.length = 0;
		fold.reads.length = 0;
		const calls = fold.statusCalls;
		fold.notes = { "inbox/other.md": "other\n", "inbox/a.md": "another space's\n" };
		const { state, report } = await syncSpace(fold, store, first.state, { space: "second", force: true });
		expect(report.stoppedBy).toBe(OTHER_SPACE);
		expect(store.log).toEqual([]);
		expect(fold.statusCalls).toBe(calls);
		expect(state).toBe(first.state);
		expect(store.text("inbox/a.md")).toBe("a\n");
	});

	it("may choose another space while it holds no notes", async () => {
		const fold = new FakeFold({});
		const store = new MemoryStore();
		const empty = await syncSpace(fold, store, NOTHING_YET, { space: "first" });
		fold.notes = { "inbox/b.md": "b\n" };
		const { state } = await syncSpace(fold, store, empty.state, { space: "second" });
		expect(state.space).toBe("second");
		expect(store.text("inbox/b.md")).toBe("b\n");
	});
});

describe("a note that only moved is never missing", () => {
	const moved = async (arrange: (fold: FakeFold, store: MemoryStore) => void) => {
		const fold = new FakeFold({ "inbox/rye.md": "rye\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.log.length = 0;
		fold.notes = { "managed/rye.md": "rye\n" };
		fold.served = "2";
		arrange(fold, store);
		return { fold, store, first, second: await round(fold, store, first.state) };
	};

	it("stays where it was while its new path is not served yet", async () => {
		const { store, second } = await moved((fold) => fold.notIndexed.add("managed/rye.md"));
		expect(store.log).toEqual([]);
		expect(store.text("inbox/rye.md")).toBe("rye\n");
		expect(second.report.waiting).toBe(1);
		expect(second.state.files["inbox/rye.md"]).toBeDefined();
	});

	it("stays where it was while reading its new path fails, then moves", async () => {
		const { fold, store, second } = await moved((f) => f.readRefusals.set("managed/rye.md", refusal("internal", 500)));
		expect(store.text("inbox/rye.md")).toBe("rye\n");
		fold.readRefusals.clear();
		await round(fold, store, second.state);
		expect(store.text("managed/rye.md")).toBe("rye\n");
		expect(store.files.has("inbox/rye.md")).toBe(false);
	});

	it("stays where it was when a person's own file holds its new path", async () => {
		const { store, second } = await moved((_, s) => s.put("managed/rye.md", "my own\n"));
		expect(store.text("inbox/rye.md")).toBe("rye\n");
		expect(store.text("managed/rye.md")).toBe("my own\n");
		expect(second.report.blocked).toEqual(["managed/rye.md"]);
	});

	it("stays where it was when sleep changed its bytes in filing it, while the filed note is not served yet", async () => {
		const fold = new FakeFold({ "inbox/rye.md": "rye\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.log.length = 0;
		fold.notes = { "managed/grain/rye.md": "---\nupdated: 2026-11-03\n---\nrye\n" };
		fold.notIndexed.add("managed/grain/rye.md");
		fold.served = "2";
		const second = await round(fold, store, first.state);
		expect(store.log).toEqual([]);
		expect(store.text("inbox/rye.md")).toBe("rye\n");
		expect(second.state.revision).toBe("1");
		fold.notIndexed.clear();
		fold.served = "3";
		await round(fold, store, second.state);
		expect(store.files.has("inbox/rye.md")).toBe(false);
		expect(store.text("managed/grain/rye.md")).toContain("updated:");
	});

	it("stays where it was when reading the filed note fails, though its bytes changed", async () => {
		const fold = new FakeFold({ "inbox/rye.md": "rye\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		fold.notes = { "managed/rye.md": "filed\n" };
		fold.readRefusals.set("managed/rye.md", refusal("internal", 500));
		fold.served = "2";
		await round(fold, store, first.state);
		expect(store.text("inbox/rye.md")).toBe("rye\n");
	});

	it("is the same file when only the spelling of its name changed, so it is not put in the trash", async () => {
		const fold = new FakeFold({ "managed/cafe\u0301.md": "cafe\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.log.length = 0;
		fold.notes = { "managed/caf\u00e9.md": "cafe\n" };
		fold.served = "2";
		const { state, report } = await round(fold, store, first.state);
		expect(report.trashed).toBe(0);
		expect(store.text("managed/caf\u00e9.md")).toBe("cafe\n");
		expect(Object.keys(state.files)).toEqual(["managed/caf\u00e9.md"]);
	});

	it("waits for a note the index skipped, which has no hash, and that holds nothing else back", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		fold.listAnswer = { revision: "1", files: [{ path: "inbox/skipped.md", bytes: 1, hash: null, indexed: false }, { path: "inbox/a.md", bytes: 2, hash: await sha256(new TextEncoder().encode("a\n")), indexed: true }] };
		const store = new MemoryStore();
		const { report } = await round(fold, store);
		expect(report).toMatchObject({ waiting: 1, written: 1, complete: true });
		expect(report.stoppedBy).toBeUndefined();
	});
});

describe("many removals at once", () => {
	const many = (count: number, prefix = "inbox/n") => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}.md`, `note ${i}\n`]));

	it("wait for a person when a timer finds most of a vault gone", async () => {
		const fold = new FakeFold(many(30));
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.log.length = 0;
		fold.notes = many(3);
		fold.served = "2";
		const { state, report } = await round(fold, store, first.state);
		expect(store.log).toEqual([]);
		expect(report).toMatchObject({ heldRemovals: 27, complete: false });
		expect(state.revision).toBe("1");
		// A person asking takes them away, by way of the trash.
		const asked = await round(fold, store, state, true);
		expect(asked.report.trashed).toBe(27);
		expect(asked.state.revision).toBe("2");
	});

	it("stay held poll after poll, until a person asks", async () => {
		const fold = new FakeFold(many(30));
		const store = new MemoryStore();
		let { state } = await round(fold, store);
		store.log.length = 0;
		fold.notes = many(3);
		fold.served = "2";
		for (let poll = 0; poll < 3; poll += 1) {
			const next = await round(fold, store, state);
			expect(next.report.heldRemovals).toBe(27);
			state = next.state;
		}
		expect(store.log).toEqual([]);
	});

	it("are no alarm when sleep files an inbox, though filing changes every note's bytes", async () => {
		const notes = many(30);
		const fold = new FakeFold(notes);
		const store = new MemoryStore();
		const first = await round(fold, store);
		fold.notes = Object.fromEntries(Object.entries(notes).map(([path, text]) => [path.replace("inbox/", "managed/"), `---\nupdated: 2026-11-03\n---\n${text}`]));
		fold.served = "2";
		const { report } = await round(fold, store, first.state);
		expect(report).toMatchObject({ written: 30, trashed: 30, heldRemovals: 0, complete: true });
	});

	it("go ahead on a timer when few, or a small part of the vault", async () => {
		const fold = new FakeFold(many(100));
		const store = new MemoryStore();
		const first = await round(fold, store);
		fold.notes = many(70);
		fold.served = "2";
		const { report } = await round(fold, store, first.state);
		expect(report).toMatchObject({ trashed: 30, heldRemovals: 0, complete: true });
	});

	it("do not count notes that only moved, so sleep filing an inbox does not stop", async () => {
		const notes = many(30);
		const fold = new FakeFold(notes);
		const store = new MemoryStore();
		const first = await round(fold, store);
		fold.notes = Object.fromEntries(Object.entries(notes).map(([path, text]) => [path.replace("inbox/", "managed/"), text]));
		fold.served = "2";
		const { report } = await round(fold, store, first.state);
		expect(report).toMatchObject({ written: 30, trashed: 30, heldRemovals: 0, complete: true });
	});
});

describe("a round after the first", () => {
	it("asks only whether the space moved, when it has not", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		fold.reads.length = 0;
		const { report } = await round(fold, store, first.state);
		expect(report.ran).toBe(false);
		expect(fold.listCalls).toBe(1);
		expect(fold.reads).toEqual([]);
	});

	it("reads only the note that changed", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n", "inbox/b.md": "b\n", "inbox/c.md": "c\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		fold.reads.length = 0;
		fold.notes["inbox/b.md"] = "b, changed\n";
		fold.served = "2";
		const { state, report } = await round(fold, store, first.state);
		expect(fold.reads).toEqual(["inbox/b.md"]);
		expect(store.text("inbox/b.md")).toBe("b, changed\n");
		expect(report.written).toBe(1);
		expect(state.revision).toBe("2");
	});

	it("notices an edit that keeps a file's size, which the list's sizes alone could not", async () => {
		const fold = new FakeFold({ "inbox/a.md": "cat\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		fold.notes["inbox/a.md"] = "dog\n";
		fold.served = "2";
		await round(fold, store, first.state);
		expect(store.text("inbox/a.md")).toBe("dog\n");
	});

	it("leaves a note that is not served yet as it was, and takes it later", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		fold.notes["inbox/a.md"] = "a, changed\n";
		fold.notes["inbox/new.md"] = "new\n";
		fold.notIndexed = new Set(["inbox/a.md", "inbox/new.md"]);
		fold.served = "2";
		const second = await round(fold, store, first.state);
		expect(second.report.waiting).toBe(2);
		expect(store.text("inbox/a.md")).toBe("a\n");
		expect(store.files.has("inbox/new.md")).toBe(false);
		fold.notIndexed = new Set();
		fold.served = "3";
		await round(fold, store, second.state);
		expect(store.text("inbox/a.md")).toBe("a, changed\n");
		expect(store.text("inbox/new.md")).toBe("new\n");
	});

	it("puts a removed note in the trash, and only after the new ones are in, so a filed note is never missing", async () => {
		const fold = new FakeFold({ "inbox/rye.md": "rye\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.log.length = 0;
		fold.notes = { "managed/bread/rye.md": "rye\n" };
		fold.served = "2";
		const { state, report } = await round(fold, store, first.state);
		expect(store.log).toEqual(["write managed/bread/rye.md", "trash inbox/rye.md"]);
		expect(report.trashed).toBe(1);
		expect(Object.keys(state.files)).toEqual(["managed/bread/rye.md"]);
	});

	it("brings back a note a person deleted, when they ask", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.files.delete("inbox/a.md");
		expect((await round(fold, store, first.state)).report.ran).toBe(false);
		expect(store.files.has("inbox/a.md")).toBe(false);
		await round(fold, store, first.state, true);
		expect(store.text("inbox/a.md")).toBe("a\n");
	});
});

describe("what a person has in the vault", () => {
	it("is never overwritten when it is their own file, and holds nothing else back", async () => {
		const fold = new FakeFold({ "inbox/mine.md": "from Fold\n", "inbox/other.md": "other\n" });
		const store = new MemoryStore();
		store.put("inbox/mine.md", "my own note\n");
		const { state, report } = await round(fold, store);
		expect(store.text("inbox/mine.md")).toBe("my own note\n");
		expect(report.blocked).toEqual(["inbox/mine.md"]);
		expect(state.files["inbox/mine.md"]).toBeUndefined();
		// The list's hash already says it differs, so it is never read, this round or any other.
		expect(fold.reads).toEqual(["inbox/other.md"]);
		expect(store.text("inbox/other.md")).toBe("other\n");
		expect(state.revision).toBe("1");
	});

	it("is never touched when it was never Fold's, whatever Fold's list says", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const store = new MemoryStore();
		store.put("inbox/my-own.md", "mine\n");
		store.put(".obsidian/app.json", "{}\n");
		const first = await round(fold, store);
		fold.notes = {};
		fold.served = "2";
		await round(fold, store, first.state);
		expect(store.text("inbox/my-own.md")).toBe("mine\n");
		expect(store.text(".obsidian/app.json")).toBe("{}\n");
		expect(store.files.has("inbox/a.md")).toBe(false);
	});

	it("is not put at risk by saved state naming something that is no note, as a vault from someone else could", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const store = new MemoryStore();
		store.put("Important.md", "mine\n");
		store.put(".obsidian/app.json", "{}\n");
		const planted: SyncState = { space: "s", revision: "0", opened: {}, files: { "Important.md": await sha256(new TextEncoder().encode("mine\n")), ".obsidian/app.json": await sha256(new TextEncoder().encode("{}\n")), "../../outside.md": "x" } };
		const { state, report } = await round(fold, store, planted);
		expect(store.log).toEqual(["write inbox/a.md"]);
		expect(report.trashed).toBe(0);
		expect(store.text("Important.md")).toBe("mine\n");
		expect(Object.keys(state.files)).toEqual(["inbox/a.md"]);
	});

	it("is kept beside the new version when they edited a note Fold changed", async () => {
		const fold = new FakeFold({ "managed/a.md": "first\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.put("managed/a.md", "my edit\n");
		fold.notes["managed/a.md"] = "second\n";
		fold.served = "2";
		const { report } = await round(fold, store, first.state);
		expect(store.text("managed/a.md")).toBe("second\n");
		expect(store.text("managed/a (local edit).md")).toBe("my edit\n");
		expect(report.editCopies).toEqual(["managed/a (local edit).md"]);
	});

	it("takes a second edit copy without losing the first", async () => {
		const fold = new FakeFold({ "managed/a.md": "first\n" });
		const store = new MemoryStore();
		let { state } = await round(fold, store);
		for (const [version, edit] of [["2", "edit one\n"], ["3", "edit two\n"]] as const) {
			store.put("managed/a.md", edit);
			fold.notes["managed/a.md"] = `version ${version}\n`;
			fold.served = version;
			({ state } = await round(fold, store, state));
		}
		expect(store.text("managed/a (local edit).md")).toBe("edit one\n");
		expect(store.text("managed/a (local edit 2).md")).toBe("edit two\n");
	});

	describe("is not mistaken for an edit when Obsidian only opened the note", () => {
		// What Obsidian was measured doing to a note it opened and closed: no byte order mark, and every line ending a line feed.
		const FROM_FOLD = "\ufeff# Title\r\n\r\nline\rlone\r\nend";
		const AS_OPENED = "# Title\n\nline\nlone\nend";

		it("so Fold's new version replaces it with no copy", async () => {
			const fold = new FakeFold({ "managed/a.md": FROM_FOLD });
			const store = new MemoryStore();
			const first = await round(fold, store);
			expect(store.files.get("managed/a.md")).toEqual(new TextEncoder().encode(FROM_FOLD));
			store.put("managed/a.md", AS_OPENED);
			fold.notes["managed/a.md"] = "# Second\n";
			fold.served = "2";
			const { report } = await round(fold, store, first.state);
			expect(report.editCopies).toEqual([]);
			expect(store.text("managed/a.md")).toBe("# Second\n");
		});

		it("so a note Fold removed still goes to the trash", async () => {
			const fold = new FakeFold({ "managed/a.md": FROM_FOLD });
			const store = new MemoryStore();
			const first = await round(fold, store);
			store.put("managed/a.md", AS_OPENED);
			fold.notes = {};
			fold.served = "2";
			const { state, report } = await round(fold, store, first.state);
			expect(report).toMatchObject({ trashed: 1, keptEdited: [] });
			expect(state.opened).toEqual({});
		});

		it("yet a real edit of such a note is still kept", async () => {
			const fold = new FakeFold({ "managed/a.md": FROM_FOLD });
			const store = new MemoryStore();
			const first = await round(fold, store);
			store.put("managed/a.md", `${AS_OPENED}, and my words`);
			fold.notes["managed/a.md"] = "# Second\n";
			fold.served = "2";
			const { report } = await round(fold, store, first.state);
			expect(report.editCopies).toEqual(["managed/a (local edit).md"]);
			expect(store.text("managed/a (local edit).md")).toBe(`${AS_OPENED}, and my words`);
		});

		it("and a plain note, which opening leaves alone, adds nothing to what is saved", async () => {
			const fold = new FakeFold({ "managed/plain.md": "# Plain\n\nline\n" });
			const { state } = await round(fold, new MemoryStore());
			expect(state.opened).toEqual({});
		});
	});

	it("is kept once when the note cannot be written, not a new copy every round", async () => {
		const fold = new FakeFold({ "managed/a.md": "first\n" });
		const store = new MemoryStore();
		let { state } = await round(fold, store);
		store.put("managed/a.md", "my edit\n");
		store.locked.add("managed/a.md");
		fold.notes["managed/a.md"] = "second\n";
		fold.served = "2";
		for (let i = 0; i < 4; i += 1) ({ state } = await round(fold, store, state));
		expect([...store.files.keys()].filter((path) => path.includes("local edit"))).toEqual(["managed/a (local edit).md"]);
		store.locked.clear();
		await round(fold, store, state);
		expect(store.text("managed/a.md")).toBe("second\n");
	});

	it("stays when Fold removes a note they edited", async () => {
		const fold = new FakeFold({ "inbox/a.md": "first\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.put("inbox/a.md", "my edit\n");
		fold.notes = {};
		fold.served = "2";
		const { state, report } = await round(fold, store, first.state);
		expect(store.text("inbox/a.md")).toBe("my edit\n");
		expect(report.keptEdited).toEqual(["inbox/a.md"]);
		expect(state.files).toEqual({});
	});

	it("is taken as Fold's when it already holds exactly Fold's bytes, so an interrupted first round picks up", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const store = new MemoryStore();
		store.put("inbox/a.md", "a\n");
		const { state, report } = await round(fold, store);
		expect(store.log).toEqual([]);
		expect(fold.reads).toEqual([]);
		expect(report.written).toBe(0);
		expect(state.files["inbox/a.md"]).toBeDefined();
	});
});

describe("when something goes wrong", () => {
	it("writes nothing whose bytes do not match Fold's hash, and tries again next time", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n", "inbox/b.md": "b\n" });
		fold.wrongHash.add("inbox/a.md");
		const store = new MemoryStore();
		const first = await round(fold, store);
		expect(store.files.has("inbox/a.md")).toBe(false);
		expect(store.text("inbox/b.md")).toBe("b\n");
		expect(first.report).toMatchObject({ complete: false, failed: ["inbox/a.md"] });
		expect(first.state.revision).toBeNull();
		fold.wrongHash.clear();
		fold.reads.length = 0;
		const second = await round(fold, store, first.state);
		expect(fold.reads).toEqual(["inbox/a.md"]);
		expect(second.state.revision).toBe("1");
	});

	it("writes nothing when the hash did not come at all", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const content = fold.content;
		fold.content = async (space, path) => ({ ...(await content(space, path)), hash: null });
		const store = new MemoryStore();
		const { report } = await round(fold, store);
		expect(store.files.size).toBe(0);
		expect(report.failed).toEqual(["inbox/a.md"]);
	});

	it.each([
		["no list at all", undefined],
		["no files in it", { revision: "2" }],
		["no revision, and nothing listed", { revision: null, files: [] }],
		["files that are not a list", { revision: "2", files: "none" }],
		["an entry with no path", { revision: "2", files: [{ bytes: 1 }] }],
		["a note with no hash, as a Fold older than the plugin answers", { revision: "2", files: [{ path: "inbox/a.md", bytes: 2, indexed: true }] }],
		["a note with a hash not in Fold's form", { revision: "2", files: [{ path: "inbox/a.md", bytes: 2, hash: "../../x", indexed: true }] }],
	])("deletes nothing on a list it cannot trust: %s", async (_name, answer) => {
		const fold = new FakeFold({ "inbox/a.md": "a\n", "inbox/b.md": "b\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.log.length = 0;
		fold.served = "2";
		fold.listAnswer = answer === undefined ? null : answer;
		const { state, report } = await round(fold, store, first.state);
		expect(store.log).toEqual([]);
		expect(report.stoppedBy).toBeDefined();
		expect(state).toEqual(first.state);
	});

	it.each(["unauthorised", "not-found", "access-unavailable", "identity-unavailable", "rate-limited", "unreachable"])("deletes nothing and stops when the list is refused with %s", async (code) => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.log.length = 0;
		fold.served = "2";
		fold.listRefusal = refusal(code);
		const { state, report } = await round(fold, store, first.state);
		expect(store.log).toEqual([]);
		expect(report.stoppedBy).toBe(fold.listRefusal);
		expect(state).toEqual(first.state);
	});

	it("stops at a refused token part way, keeps what it did, and does not read it again", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n", "inbox/b.md": "b\n", "inbox/c.md": "c\n" });
		fold.readRefusals.set("inbox/b.md", refusal("unauthorised", 401));
		const store = new MemoryStore();
		const first = await round(fold, store);
		expect(fold.reads).toEqual(["inbox/a.md", "inbox/b.md"]);
		expect(first.report.stoppedBy).toBeDefined();
		expect(first.state.revision).toBeNull();
		expect(Object.keys(first.state.files)).toEqual(["inbox/a.md"]);
		fold.readRefusals.clear();
		fold.reads.length = 0;
		const second = await round(fold, store, first.state);
		expect(fold.reads).toEqual(["inbox/b.md", "inbox/c.md"]);
		expect(second.state.revision).toBe("1");
	});

	it("does not remove anything in a round stopped before the removals", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.log.length = 0;
		fold.notes = { "inbox/b.md": "b\n" };
		fold.served = "2";
		fold.readRefusals.set("inbox/b.md", refusal("access-unavailable", 503));
		await round(fold, store, first.state);
		expect(store.log).toEqual([]);
		expect(store.files.has("inbox/a.md")).toBe(true);
	});

	it.each(["file-not-found", "changed", "indexing", "internal"])("carries on past one note refused with %s, and tries it again", async (code) => {
		const fold = new FakeFold({ "inbox/a.md": "a\n", "inbox/b.md": "b\n" });
		fold.readRefusals.set("inbox/a.md", refusal(code));
		const store = new MemoryStore();
		const { state, report } = await round(fold, store);
		expect(store.text("inbox/b.md")).toBe("b\n");
		expect(report).toMatchObject({ complete: false, failed: ["inbox/a.md"] });
		expect(state.revision).toBeNull();
	});

	it("does not keep asking for a note too large for one answer", async () => {
		const fold = new FakeFold({ "inbox/huge.md": "x\n", "inbox/b.md": "b\n" });
		fold.readRefusals.set("inbox/huge.md", refusal("too-large", 413));
		const store = new MemoryStore();
		const { state, report } = await round(fold, store);
		expect(report).toMatchObject({ complete: true, blocked: ["inbox/huge.md"] });
		expect(state.revision).toBe("1");
	});

	it("carries on past one local file it cannot read, and says so", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n", "inbox/b.md": "b\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.unreadable.add("inbox/a.md");
		fold.notes = { "inbox/a.md": "a, changed\n", "inbox/b.md": "b, changed\n" };
		fold.served = "2";
		const { report } = await round(fold, store, first.state);
		expect(report.failed).toEqual(["inbox/a.md"]);
		expect(store.text("inbox/b.md")).toBe("b, changed\n");
		expect(report.stoppedBy).toBeUndefined();
	});

	it("holds removals while a note keeps failing, says so, and lets a person take them away", async () => {
		const fold = new FakeFold({ "inbox/gone.md": "gone\n", "inbox/stuck.md": "stuck\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		store.log.length = 0;
		fold.notes = { "inbox/stuck.md": "stuck, changed\n" };
		fold.served = "2";
		store.locked.add("inbox/stuck.md");
		const held = await round(fold, store, first.state);
		expect(held.report).toMatchObject({ failed: ["inbox/stuck.md"], removalsWaiting: 1, trashed: 0 });
		expect(store.files.has("inbox/gone.md")).toBe(true);
		const asked = await round(fold, store, held.state, true);
		expect(asked.report).toMatchObject({ failed: ["inbox/stuck.md"], trashed: 1, complete: false });
		expect(store.files.has("inbox/gone.md")).toBe(false);
	});

	it("stops on a status not in Fold's shape", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const store = new MemoryStore();
		const first = await round(fold, store);
		for (const answer of [{}, { servedRevision: 7 }, undefined]) {
			fold.status = async () => answer as never;
			const { state, report } = await round(fold, store, first.state, true);
			expect(report.stoppedBy).toBeDefined();
			expect(state.revision).toBe("1");
			expect(state.files).toEqual(first.state.files);
		}
	});

	it("tries again when the disk refuses, losing nothing", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n" });
		const store = new MemoryStore();
		store.failWrites = true;
		const first = await round(fold, store);
		expect(first.report.failed).toEqual(["inbox/a.md"]);
		expect(first.state.files).toEqual({});
		store.failWrites = false;
		await round(fold, store, first.state);
		expect(store.text("inbox/a.md")).toBe("a\n");
	});

	it("stops between notes when the plugin is unloaded, and picks up later", async () => {
		const fold = new FakeFold({ "inbox/a.md": "a\n", "inbox/b.md": "b\n" });
		const store = new MemoryStore();
		let stop = false;
		const first = await syncSpace(fold, store, NOTHING_YET, { ...SPACE, stopped: () => stop, progress: () => { stop = true; } });
		expect(store.files.size).toBe(1);
		expect(first.state.revision).toBeNull();
		await round(fold, store, first.state);
		expect(store.files.size).toBe(2);
	});

	it("saves what it has done during a long round", async () => {
		const notes = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`inbox/n${i}.md`, `${i}\n`]));
		const saved: number[] = [];
		await syncSpace(new FakeFold(notes), new MemoryStore(), NOTHING_YET, { ...SPACE, checkpoint: async (state) => { saved.push(Object.keys(state.files).length); expect(state.revision).toBeNull(); } });
		expect(saved).toEqual([25, 50]);
	});
});
