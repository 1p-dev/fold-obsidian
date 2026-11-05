import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api/client";
import { CALL_TIMEOUT_MS, fetchOver, foldClient, type Http, queryAddress, resolveAddresses } from "./fold";
import { OTHER_SPACE, type SyncReport } from "./sync";
import { NOT_TEXT } from "./sync";
import { describeHeld, describeNotSent, describeRefusal, describeRound } from "./words";

const QUERY = "https://query.fold.test";
const READING = { query: QUERY, control: null };
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

// The plugin takes its timers from window, as Obsidian asks of a plugin so popout windows work; in Node that is the global scope.
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});

describe("the way out through requestUrl", () => {
	it("keeps a body as bytes and asks not to throw on a refusal", async () => {
		const sent: unknown[] = [];
		const body = new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0x0d, 0x0a, 0xff]);
		const http: Http = async (request) => {
			sent.push(request);
			return { status: 200, headers: {}, arrayBuffer: body.buffer as ArrayBuffer };
		};
		const answer = await fetchOver(http)(`${QUERY}/x`, { method: "GET", headers: { authorization: "Bearer t" } });
		expect(new Uint8Array(await answer.arrayBuffer())).toEqual(body);
		expect(sent).toEqual([{ url: `${QUERY}/x`, method: "GET", headers: { authorization: "Bearer t" }, throw: false }]);
	});

	it("sends a write's JSON as text, and refuses any other body", async () => {
		const sent: unknown[] = [];
		const http: Http = async (request) => {
			sent.push(request);
			return { status: 200, headers: {}, arrayBuffer: bytes("{}") };
		};
		await fetchOver(http)(`${QUERY}/x`, { method: "PUT", headers: { "content-type": "application/json" }, body: '{"text":"# A\\n"}' });
		expect(sent).toEqual([{ url: `${QUERY}/x`, method: "PUT", headers: { "content-type": "application/json" }, body: '{"text":"# A\\n"}', throw: false }]);
		await expect(fetchOver(http)(`${QUERY}/x`, { method: "PUT", body: new Uint8Array([1]) })).rejects.toThrow();
		expect(sent).toHaveLength(1);
	});

	it("reads a header however the platform writes its name, since phones may keep its case", async () => {
		const http: Http = async () => ({ status: 200, headers: { "Fold-Revision": "7", "FOLD-HASH": "abc" }, arrayBuffer: bytes("x") });
		const content = await foldClient(READING, () => "t", http).content("s", "inbox/a.md");
		expect(content).toEqual({ text: "x", revision: "7", hash: "abc" });
	});

	it("answers a status that may have no body without failing", async () => {
		const http: Http = async () => ({ status: 204, headers: {}, arrayBuffer: new ArrayBuffer(0) });
		expect((await fetchOver(http)(`${QUERY}/x`)).status).toBe(204);
	});

	it("turns a refusal into Fold's code, and a lost network into unreachable", async () => {
		const refused: Http = async () => ({ status: 401, headers: { "content-type": "application/json" }, arrayBuffer: bytes('{"error":"unauthorised","detail":"the credential was refused"}') });
		await expect(foldClient(READING, () => "t", refused).status("s")).rejects.toMatchObject({ code: "unauthorised", status: 401 });
		const lost: Http = async () => {
			throw new Error("net::ERR_INTERNET_DISCONNECTED");
		};
		await expect(foldClient(READING, () => "t", lost).status("s")).rejects.toMatchObject({ code: "unreachable" });
	});

	it("gives up on a call that never answers, so one lost call cannot stop every later round", async () => {
		vi.useFakeTimers();
		try {
			const silent: Http = () => new Promise(() => {});
			const answer = foldClient(READING, () => "t", silent).status("s");
			const refused = expect(answer).rejects.toMatchObject({ code: "unreachable" });
			await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + 1);
			await refused;
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses bytes that are not UTF-8 rather than write what it could not read exactly", async () => {
		const http: Http = async () => ({ status: 200, headers: { "fold-revision": "1", "fold-hash": "x" }, arrayBuffer: new Uint8Array([0x23, 0xff, 0xfe]).buffer as ArrayBuffer });
		await expect(foldClient(READING, () => "t", http).content("s", "inbox/a.md")).rejects.toMatchObject({ code: "internal" });
	});

	it("sends nothing at all with no token, and the token only in its header", async () => {
		const seen: string[] = [];
		const http: Http = async (request) => {
			seen.push(request.url);
			return { status: 200, headers: {}, arrayBuffer: bytes("{}") };
		};
		await expect(foldClient(READING, () => null, http).status("s")).rejects.toMatchObject({ code: "unauthorised" });
		expect(seen).toEqual([]);
		await foldClient(READING, () => "a-secret-token", http).status("s");
		expect(seen.join()).not.toContain("a-secret-token");
	});

	it("encodes a path's segments, so a name can never become a route", async () => {
		const seen: string[] = [];
		const http: Http = async (request) => {
			seen.push(request.url);
			return { status: 200, headers: { "fold-revision": "1" }, arrayBuffer: bytes("x") };
		};
		await foldClient(READING, () => "t", http).content("s", "inbox/a b#c?d.md");
		expect(seen).toEqual([`${QUERY}/v1/spaces/s/content/inbox/a%20b%23c%3Fd.md`]);
		await expect(foldClient(READING, () => "t", http).content("s", "inbox/../../x.md")).rejects.toMatchObject({ code: "bad-request" });
	});
});

describe("the query address", () => {
	it("is a plain https address", () => {
		expect(queryAddress("https://abc.lambda-url.us-east-1.on.aws")).toBe("https://abc.lambda-url.us-east-1.on.aws");
		expect(queryAddress("  https://fold.example/api/ ")).toBe("https://fold.example/api");
	});

	it.each(["http://fold.example", "ftp://fold.example", "fold.example", "", "javascript:alert(1)", "file:///etc/passwd", "https://user:pass@fold.example", "https://fold.example?x=1", "https://fold.example#x"])("refuses %j, so a token never goes in the clear or to a host it only seems to name", (text) => { // secret-scan-ok: a hostile address the test proves is refused
		expect(queryAddress(text)).toBeNull();
	});
});

describe("Fold's addresses", () => {
	const WEB = "https://fold.example.test";
	const answering = (status: number, text: string, asked: string[] = []): Http => async (request) => {
		asked.push(`${request.url} ${request.headers.authorization ?? "no token"}`);
		return { status, headers: {}, arrayBuffer: bytes(text) };
	};

	it("come from the web app's settings, read without the token", async () => {
		const asked: string[] = [];
		const config = JSON.stringify({ queryUrl: "https://q.fold.test", controlUrl: "https://c.fold.test/", mcpUrl: "https://m.fold.test/mcp", issuer: "https://i.test", clientId: "fold-web" });
		expect(await resolveAddresses(`${WEB}/`, answering(200, config, asked))).toEqual({ query: "https://q.fold.test", control: "https://c.fold.test" });
		expect(asked).toEqual([`${WEB}/config.json no token`]);
	});

	it("are the query part's own, for reading only, when the address is not the web app's", async () => {
		expect(await resolveAddresses(QUERY, answering(404, '{"error":"not-found"}'))).toEqual(READING);
		expect(await resolveAddresses(QUERY, answering(401, '{"error":"unauthorised"}'))).toEqual(READING);
		expect(await resolveAddresses(QUERY, answering(200, "<!doctype html><title>Fold</title>"))).toEqual(READING);
	});

	it("never take an address from the settings that is not plain https", async () => {
		for (const [queryUrl, controlUrl] of [
			["http://q.fold.test", "https://c.fold.test"],
			["https://q.fold.test", "https://user:pass@c.fold.test"], // secret-scan-ok: an address with credentials, which the test checks is refused
			["https://q.fold.test", "https://c.fold.test/?to=elsewhere"],
			["https://q.fold.test", 7],
		]) {
			expect(await resolveAddresses(WEB, answering(200, JSON.stringify({ queryUrl, controlUrl })))).toEqual({ query: WEB, control: null });
		}
	});

	it("are nothing for an address that is not plain https, and nothing is asked", async () => {
		const asked: string[] = [];
		expect(await resolveAddresses("http://fold.example.test", answering(200, "{}", asked))).toBeNull();
		expect(asked).toEqual([]);
	});

	it("are not guessed when the web app cannot be reached", async () => {
		const lost: Http = async () => {
			throw new Error("offline");
		};
		await expect(resolveAddresses(WEB, lost)).rejects.toThrow();
	});
});

describe("what a person is told", () => {
	it("says what to do about a refused token, in the plugin's own terms", () => {
		expect(describeRefusal(new ApiError(401, "unauthorised", "the credential was refused"))).toBe("Fold refused the token. Check it in this plugin's settings.");
	});

	it("says the notes stay when a space can no longer be reached", () => {
		expect(describeRefusal(new ApiError(404, "not-found", "no such space"))).toContain("The notes already here stay as they are.");
	});

	it("says a vault already holds another space, and what to do", () => {
		expect(describeRefusal(OTHER_SPACE)).toContain("Disconnect");
	});

	it("gives anything else in the web app's own words", () => {
		expect(describeRefusal(new ApiError(0, "unreachable", "x"))).toBe("Fold could not be reached. Check your connection and try again.");
	});
});

describe("what the status bar says", () => {
	const round = (over: Partial<SyncReport>): SyncReport => ({ ran: true, notes: 0, complete: true, written: 0, trashed: 0, waiting: 0, editCopies: [], keptEdited: [], blocked: [], failed: [], heldRemovals: 0, removalsWaiting: 0, sent: [], added: [], notSent: [], done: [], ...over });

	it("does not say a space has no notes while they are still being indexed", () => {
		expect(describeHeld(0, round({ notes: 60, waiting: 60 }))).toBe("Fold: 0 notes, 60 being indexed");
		expect(describeHeld(12, round({ notes: 60, waiting: 48 }))).toBe("Fold: 12 notes, 48 being indexed");
	});

	it("says a space has none only when it has none", () => {
		expect(describeHeld(0, round({}))).toBe("Fold: no notes");
		expect(describeHeld(1, round({ notes: 1 }))).toBe("Fold: 1 note");
		expect(describeHeld(0, round({ notes: 1, failed: ["inbox/a.md"] }))).toBe("Fold: no notes, 1 failed");
	});
});

describe("what a round says", () => {
	const round = (over: Partial<SyncReport>): SyncReport => ({ ran: true, notes: 0, complete: true, written: 0, trashed: 0, waiting: 0, editCopies: [], keptEdited: [], blocked: [], failed: [], heldRemovals: 0, removalsWaiting: 0, sent: [], added: [], notSent: [], done: [], ...over });
	const none = new Set<string>();

	it("says everything when a person asked", () => {
		expect(describeRound(round({ written: 2, trashed: 1, failed: ["a"] }), true, none)).toBe("Fold: 2 notes updated; 1 note moved to the trash; a failed and will be tried again.");
		expect(describeRound(round({}), true, none)).toBeNull();
	});

	it("says nothing of routine work on a timer, since a busy space moves every few minutes", () => {
		expect(describeRound(round({ written: 40, trashed: 3, waiting: 5 }), false, none)).toBeNull();
	});

	it("always says when a person's own edit was involved", () => {
		expect(describeRound(round({ editCopies: ["inbox/a (local edit).md"] }), false, none)).toBe("Fold: your edits kept in inbox/a (local edit).md.");
		expect(describeRound(round({ keptEdited: ["inbox/a.md"] }), false, none)).toBe("Fold: inbox/a.md kept though Fold removed it, since you edited it.");
	});

	it("says a space's removals are waiting, once on a timer", () => {
		const held = round({ heldRemovals: 30 });
		expect(describeRound(held, false, none)).toContain("Fold removed 30 notes, most of this vault");
		expect(describeRound(held, false, new Set(["held removals"]))).toBeNull();
	});

	it("names a note that failed once on a timer, so a note that can never come is not silent", () => {
		expect(describeRound(round({ failed: ["inbox/a.md"] }), false, none)).toBe("Fold: inbox/a.md failed and will be tried again.");
		expect(describeRound(round({ failed: ["inbox/a.md"] }), false, new Set(["inbox/a.md"]))).toBeNull();
	});

	it("says removals are waiting on a note that failed, so a stuck vault is not silent", () => {
		expect(describeRound(round({ failed: ["inbox/a.md"], removalsWaiting: 3 }), false, none)).toBe('Fold: inbox/a.md failed and will be tried again; 3 notes Fold removed stay here until then, or until you run "Sync notes now".');
	});

	it("says when asked how many notes are still being indexed", () => {
		expect(describeRound(round({ waiting: 2 }), true, none)).toBe("Fold: 2 notes still being indexed.");
		expect(describeRound(round({ waiting: 2 }), false, none)).toBeNull();
	});

	it("names what could not come, once on a timer and each time when asked", () => {
		const blocked = ["inbox/a.md", "inbox/b.md", "inbox/c.md", "inbox/d.md"];
		expect(describeRound(round({ blocked }), false, none)).toBe("Fold: inbox/a.md, inbox/b.md, inbox/c.md and 1 more could not come here.");
		expect(describeRound(round({ blocked }), false, new Set(blocked))).toBeNull();
		expect(describeRound(round({ blocked: ["inbox/new.md", ...blocked] }), false, new Set(blocked))).toBe("Fold: inbox/new.md could not come here.");
		expect(describeRound(round({ blocked: ["inbox/a.md"] }), true, new Set(blocked))).toBe("Fold: inbox/a.md could not come here.");
	});
});

describe("what a round says of sending", () => {
	const round = (over: Partial<SyncReport>): SyncReport => ({ ran: true, notes: 0, complete: true, written: 0, trashed: 0, waiting: 0, editCopies: [], keptEdited: [], blocked: [], failed: [], heldRemovals: 0, removalsWaiting: 0, sent: [], added: [], notSent: [], done: [], ...over });

	it("always says what went to Fold, since a person did it", () => {
		expect(describeRound(round({ sent: ["inbox/a.md"], added: ["inbox/new.md"] }), false, new Set())).toBe("Fold: your edits to inbox/a.md sent; inbox/new.md saved to the space's inbox.");
	});

	it("says what was not sent, each reason once with the notes it held back", () => {
		const denied = new ApiError(403, "not-permitted", "this needs edit access to the space");
		const said = describeRound(round({ notSent: [{ path: "inbox/a.md", error: denied }, { path: "managed/b.md", error: denied }, { path: "inbox/odd.md", error: NOT_TEXT }] }), false, new Set());
		expect(said).toBe("Fold: inbox/a.md, managed/b.md not sent: Fold refused it: this needs edit access to the space; inbox/odd.md not sent: it is not UTF-8 text.");
		expect(describeNotSent(new ApiError(403, "not-permitted", ""))).toContain("fold:write");
	});

	it("never asks a person to save anyway, which the plugin cannot do", () => {
		const words = describeNotSent(new ApiError(400, "holds-credential", "this looks like it holds a credential: an API key"));
		expect(words).toContain("Take it out");
		expect(words).not.toContain("save anyway");
	});
});
