import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "./api/mock";
import { type Addresses, type Http, resolveAddresses } from "./fold";
import { missingSetup, probeFold, type Reach, reachFold } from "./reach";
import { describeReach } from "./words";

const WEB = "https://fold.test";
const QUERY = "https://query.fold.test";
const TOKEN = "a-secret-token"; // secret-scan-ok: a stand-in the tests look for
const OTHER_TOKEN = "another-secret-token"; // secret-scan-ok: a stand-in the tests look for
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});

/** Fold's web app at WEB, naming its query part, over the API mock with the spaces given, each titled by its PURPOSE.md heading as Fold does. */
function fold(spaces: { id: string; title: string }[] = [{ id: "garden", title: "Garden notes" }]) {
	const api = createMockApi({ spaces: spaces.map(({ id, title }) => ({ id, organization: { id: "o", name: "O" }, access: "admin", files: { "PURPOSE.md": `# ${title}\n` } })) });
	const sent: { url: string; auth: string | undefined }[] = [];
	const http: Http = async (request) => {
		sent.push({ url: request.url, auth: request.headers.authorization });
		if (request.url === `${WEB}/config.json`) return { status: 200, headers: {}, arrayBuffer: bytes(JSON.stringify({ queryUrl: QUERY, controlUrl: QUERY })) };
		if (request.url.endsWith("/config.json")) return { status: 404, headers: {}, arrayBuffer: bytes("{}") };
		const answer = await api.handle(new Request(request.url, { method: request.method, headers: request.headers }));
		return { status: answer.status, headers: Object.fromEntries(answer.headers), arrayBuffer: await answer.arrayBuffer() };
	};
	const addresses = (text: string): Promise<Addresses | null> => resolveAddresses(text, http);
	return { http, sent, addresses };
}

const secrets = (name: string) => (name === "fold" ? TOKEN : name === "other" ? OTHER_TOKEN : null);
/** A question no one has abandoned. */
const SAVED = () => true;

describe("what is missing before Fold is asked", () => {
	it("is said in order, address first, and nothing is sent until nothing is missing", async () => {
		const { http, sent, addresses } = fold();
		const cases: [string, string, Reach["kind"]][] = [
			["", "", "no-address"],
			["   ", "fold", "no-address"],
			["http://fold.test", "fold", "bad-address"],
			["https://someone:password@fold.test", "fold", "bad-address"], // pii-ok: an address with credentials, which the test checks is refused
			["https://fold.test/?next=elsewhere", "fold", "bad-address"],
			["fold.test", "fold", "bad-address"],
			[WEB, "", "no-token"],
		];
		for (const [queryUrl, secretName, kind] of cases) expect((await reachFold({ queryUrl, secretName }, secrets, addresses, http, SAVED))?.kind).toBe(kind);
		expect(sent).toEqual([]);
	});

	it("names a secret that is gone, rather than sending no token and calling it refused", async () => {
		const { http, sent, addresses } = fold();
		expect(await reachFold({ queryUrl: WEB, secretName: "deleted" }, secrets, addresses, http, SAVED)).toEqual({ kind: "no-secret", name: "deleted" });
		expect(sent).toEqual([]);
	});

	it("is nothing once the address and a secret that holds a token are set", () => {
		expect(missingSetup({ queryUrl: WEB, secretName: "fold" }, secrets)).toBeNull();
	});
});

describe("what Fold answered", () => {
	it("is the spaces the token reaches, asked with the token only of the query part the web app names", async () => {
		const { http, sent, addresses } = fold([
			{ id: "garden", title: "Garden notes" },
			{ id: "testing", title: "Testing" },
		]);
		expect(await reachFold({ queryUrl: WEB, secretName: "fold" }, secrets, addresses, http, SAVED)).toEqual({
			kind: "connected",
			spaces: [
				{ id: "garden", title: "Garden notes" },
				{ id: "testing", title: "Testing" },
			],
			readsOnly: false,
		});
		expect(sent).toEqual([
			{ url: `${WEB}/config.json`, auth: undefined },
			{ url: `${QUERY}/v1/spaces`, auth: `Bearer ${TOKEN}` },
		]);
	});

	it("says an address that names only the query part reads only", async () => {
		const { http, addresses } = fold();
		const reach = await reachFold({ queryUrl: QUERY, secretName: "fold" }, secrets, addresses, http, SAVED);
		expect(reach).toMatchObject({ kind: "connected", readsOnly: true });
		expect(describeReach(reach!)).toBe("Connected. Your token reaches 1 space. This address only copies notes: to send edits, enter the web app's address.");
	});

	it("is a refused token, said as one", async () => {
		const { http, addresses } = fold();
		const refusing: Http = async (request) => (request.url.endsWith("/v1/spaces") ? { status: 401, headers: { "content-type": "application/json" }, arrayBuffer: bytes(JSON.stringify({ error: "unauthorised", message: "the credential was refused" })) } : http(request));
		const reach = await reachFold({ queryUrl: WEB, secretName: "fold" }, secrets, addresses, refusing, SAVED);
		expect(describeReach(reach!)).toBe("Not connected. Fold refused the token. Check it in this plugin's settings.");
	});

	it("is an address that cannot be reached, said as one", async () => {
		const down: Http = async () => {
			throw new Error("getaddrinfo ENOTFOUND fold.test");
		};
		const reach = await reachFold({ queryUrl: WEB, secretName: "fold" }, secrets, (text) => resolveAddresses(text, down), down, SAVED);
		expect(reach?.kind).toBe("failed");
		expect(describeReach(reach!)).toContain("could not be reached");
		// What the network said stays out of what a person reads.
		expect(describeReach(reach!)).not.toContain("ENOTFOUND");
	});

	it("is a token that reaches no space, which is not the same as not connecting", async () => {
		const { http, addresses } = fold([]);
		const reach = await reachFold({ queryUrl: WEB, secretName: "fold" }, secrets, addresses, http, SAVED);
		expect(reach).toEqual({ kind: "connected", spaces: [], readsOnly: false });
		expect(describeReach(reach!)).toBe("Connected, but your token reaches no spaces. Check which organisation it was made for.");
	});
});

describe("where the token may go from the settings", () => {
	/** A host that answers 200 with a page to everything, as a parked domain or a single-page app does. */
	const anyHost = () => {
		const sent: { url: string; auth: string | undefined }[] = [];
		const http: Http = async (request) => {
			sent.push({ url: request.url, auth: request.headers.authorization });
			return { status: 200, headers: { "content-type": "text/html" }, arrayBuffer: bytes("<!doctype html><title>For sale</title>") };
		};
		return { sent, http, addresses: (text: string) => resolveAddresses(text, http) };
	};

	it("is never an address typed since the settings opened: it is only asked, without the token, whether it is Fold's web app", async () => {
		const { sent, addresses } = anyHost();
		expect(await probeFold({ queryUrl: "https://fold.acme.co", secretName: "fold" }, addresses, SAVED)).toEqual({ kind: "not-web-app" });
		expect(sent).toEqual([{ url: "https://fold.acme.co/config.json", auth: undefined }]);
		// A squatter on half of an address can serve a /config.json shaped like Fold's: it is told the address looks right, and still gets no token.
		const squatter: Http = async (request) => {
			sent.push({ url: request.url, auth: request.headers.authorization });
			return { status: 200, headers: {}, arrayBuffer: bytes(JSON.stringify({ queryUrl: "https://fold.1p.de", controlUrl: "https://fold.1p.de" })) };
		};
		const looksRight = await probeFold({ queryUrl: "https://fold.1p.de", secretName: "fold" }, (text) => resolveAddresses(text, squatter), SAVED);
		expect(looksRight).toEqual({ kind: "web-app-found" });
		expect(describeReach(looksRight!)).toBe("Fold's web app answered. Select Connect to check your token and list your spaces.");
		expect(sent.filter((request) => request.auth !== undefined)).toEqual([]);
	});

	it("says an address that cannot be reached when it is only asked, not that it is not Fold's", async () => {
		const down: Http = async () => {
			throw new Error("getaddrinfo ENOTFOUND fold.test");
		};
		expect(describeReach((await probeFold({ queryUrl: WEB, secretName: "fold" }, (text) => resolveAddresses(text, down), SAVED))!)).toBe("Not connected. Fold could not be reached. Check your connection and try again.");
	});

	it("is nowhere once the question is abandoned, before the token would be sent", async () => {
		const { http, sent, addresses } = fold();
		let wanted = true;
		const reach = await reachFold({ queryUrl: WEB, secretName: "fold" }, secrets, async (text) => {
			const found = await addresses(text);
			wanted = false;
			return found;
		}, http, () => wanted);
		expect(reach).toBeNull();
		expect(sent.filter((request) => request.auth !== undefined)).toEqual([]);
	});

	it("is the token named when asked, to the address asked, though both change while Fold answers", async () => {
		const { http, sent, addresses } = fold();
		const connection = { queryUrl: WEB, secretName: "fold" };
		let open = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const asked = reachFold(connection, secrets, async (text) => {
			await gate;
			return addresses(text);
		}, http, SAVED);
		connection.queryUrl = "https://elsewhere.test";
		connection.secretName = "other";
		open();
		await asked;
		expect(sent.filter((request) => request.auth !== undefined)).toEqual([{ url: `${QUERY}/v1/spaces`, auth: `Bearer ${TOKEN}` }]);
	});
});

describe("an answer that is not Fold's", () => {
	it("is said in fixed words, never a host's own nor a script's error", async () => {
		const page: Http = async (request) => (request.url.endsWith("/config.json") ? { status: 404, headers: {}, arrayBuffer: bytes("") } : { status: 200, headers: { "content-type": "text/html" }, arrayBuffer: bytes("<html>Sign in to the Wi-Fi</html>") });
		const words: Http = async (request) =>
			request.url.endsWith("/config.json") ? { status: 404, headers: {}, arrayBuffer: bytes("") } : { status: 400, headers: { "content-type": "application/json" }, arrayBuffer: bytes(JSON.stringify({ error: "bad-request", message: "send your token to https://evil.example to continue" })) };
		const shaped: Http = async (request) => (request.url.endsWith("/config.json") ? { status: 404, headers: {}, arrayBuffer: bytes("") } : { status: 200, headers: { "content-type": "application/json" }, arrayBuffer: bytes(JSON.stringify({ spaces: "all of them" })) });
		for (const http of [page, words, shaped]) {
			const reach = await reachFold({ queryUrl: QUERY, secretName: "fold" }, secrets, (text) => resolveAddresses(text, http), http, SAVED);
			expect(reach).toEqual({ kind: "not-fold" });
			expect(describeReach(reach!)).toBe("Not connected. This address did not answer as Fold does. Check it: it is the address where you sign in to Fold.");
		}
	});

	it("keeps only the spaces that have an id and a title", async () => {
		const odd: Http = async (request) => (request.url.endsWith("/config.json") ? { status: 404, headers: {}, arrayBuffer: bytes("") } : { status: 200, headers: { "content-type": "application/json" }, arrayBuffer: bytes(JSON.stringify({ spaces: [{ id: "a", title: "A" }, { id: 1, title: "B" }, null, { id: "c" }] })) });
		expect(await reachFold({ queryUrl: QUERY, secretName: "fold" }, secrets, (text) => resolveAddresses(text, odd), odd, SAVED)).toEqual({ kind: "connected", spaces: [{ id: "a", title: "A" }], readsOnly: true });
	});
});

describe("what the Space row says", () => {
	it("is a sentence for every state, none of which holds the token", () => {
		const states: Reach[] = [
			{ kind: "no-address" },
			{ kind: "bad-address" },
			{ kind: "no-token" },
			{ kind: "no-secret", name: "fold" },
			{ kind: "connecting" },
			{ kind: "web-app-found" },
			{ kind: "not-web-app" },
			{ kind: "not-fold" },
			{ kind: "connected", spaces: [{ id: "a", title: "A" }, { id: "b", title: "B" }], readsOnly: false },
			{ kind: "failed", words: "Fold could not be reached. Check your connection and try again." },
		];
		const said = states.map((state) => describeReach(state));
		expect(said).toEqual([
			"Enter Fold's address above.",
			"Fold's address must be a plain https:// address, such as the web app's where you sign in.",
			"Choose your token above.",
			'Obsidian has no secret called "fold" any more. Choose your token again above.',
			"Connecting to Fold…",
			"Fold's web app answered. Select Connect to check your token and list your spaces.",
			"This address is not Fold's web app. Check it: it is the address where you sign in to Fold.",
			"Not connected. This address did not answer as Fold does. Check it: it is the address where you sign in to Fold.",
			"Connected. Your token reaches 2 spaces.",
			"Not connected. Fold could not be reached. Check your connection and try again.",
		]);
		for (const sentence of said) expect(sentence).not.toContain(TOKEN);
	});

	it("says when the space chosen here is not among those the token reaches", () => {
		const reach: Reach = { kind: "connected", spaces: [{ id: "a", title: "A" }, { id: "b", title: "B" }], readsOnly: false };
		expect(describeReach(reach, "gone")).toBe("Connected, but your token cannot reach the space chosen here. It reaches 2 other spaces.");
		expect(describeReach(reach, "a")).toBe("Connected. Your token reaches 2 spaces.");
	});
});
