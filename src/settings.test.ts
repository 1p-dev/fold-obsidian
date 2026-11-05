/** The settings tab's Space row over a stub of Obsidian: it says whether the plugin reached Fold, asks again when the address or the token changes, and sends the token to an address typed since the settings opened only once the person selects Connect. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "./api/mock";
import { type Http, queryAddress, resolveAddresses } from "./fold";

const stub = vi.hoisted(() => ({ http: null as unknown }));

vi.mock("obsidian", () => ({
	PluginSettingTab: class {
		constructor(
			readonly app: unknown,
			readonly plugin: unknown,
		) {}
		update() {}
		hide() {}
	},
	Notice: class {},
	requestUrl: (request: unknown) => (stub.http as (r: unknown) => unknown)(request),
}));

const { FoldSettingTab, ADDRESS_PAUSE_MS } = await import("./settings");

/** Fold's web app, whose /config.json names its parts. */
const WEB = "https://fold.test";
/** Another Fold's web app, which answers only when a test lets it. */
const SLOW = "https://slow.fold.test";
/** Fold's query part, as 0.1 asked for: it has no /config.json. */
const QUERY = "https://query.fold.test";
/** A host that answers every request with a page, as a parked domain does: what half of an address can reach. */
const PARKED = "https://fold.te";
/** Half of an address whose owner serves a /config.json shaped like Fold's, naming itself. */
const SQUAT = "https://fold.1p.de";
const TOKEN = "a-secret-token"; // secret-scan-ok: a stand-in the tests look for
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

function fold() {
	const space = (id: string, title: string) => ({ id, organization: { id: "o", name: "O" }, access: "admin" as const, files: { "PURPOSE.md": `# ${title}\n` } });
	const garden = createMockApi({ spaces: [space("garden", "Garden notes")] });
	const older = createMockApi({ spaces: [space("old", "An older answer")] });
	const sent: { url: string; auth: string | undefined }[] = [];
	let open = () => {};
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const http: Http = async (request) => {
		sent.push({ url: request.url, auth: request.headers.authorization });
		const origin = new URL(request.url).origin;
		if (origin === PARKED) return { status: 200, headers: { "content-type": "text/html" }, arrayBuffer: bytes("<title>For sale</title>") };
		if (origin === SLOW) await gate;
		if (request.url.endsWith("/config.json")) {
			if (origin === QUERY) return { status: 404, headers: {}, arrayBuffer: bytes("") };
			const query = origin === WEB ? QUERY : origin;
			return { status: 200, headers: {}, arrayBuffer: bytes(JSON.stringify({ queryUrl: query, controlUrl: query })) };
		}
		const api = origin === SLOW ? older : garden;
		const answer = await api.handle(new Request(request.url, { method: request.method, headers: request.headers }));
		return { status: answer.status, headers: Object.fromEntries(answer.headers), arrayBuffer: await answer.arrayBuffer() };
	};
	stub.http = http;
	return { sent, withToken: () => sent.filter((request) => request.auth !== undefined), release: () => open() };
}

/** A Space row drawn as Obsidian would, with what it says and offers. */
function drawRow(tab: InstanceType<typeof FoldSettingTab>) {
	const options: { value: string; text: string }[] = [];
	const row = { desc: "", value: "", buttons: new Map<string, () => unknown>() };
	const dropdown = {
		selectEl: {
			get options() {
				return options;
			},
			remove: (at: number) => options.splice(at, 1),
		},
		addOption: (value: string, text: string) => options.push({ value, text }),
		setValue: (value: string) => {
			row.value = value;
		},
		onChange: () => {},
	};
	const setting = {
		setDesc: (desc: string) => {
			row.desc = desc;
		},
		addDropdown: (draw: (d: typeof dropdown) => void) => draw(dropdown),
		addButton: (draw: (button: unknown) => void) => {
			let label = "";
			const button = {
				setButtonText: (text: string) => {
					label = text;
					return button;
				},
				onClick: (click: () => unknown) => {
					row.buttons.set(label, click);
					return button;
				},
			};
			draw(button);
		},
	};
	const space = tab.getSettingDefinitions().find((item) => "name" in item && item.name === "Space") as { render: (s: unknown) => () => void };
	const close = space.render(setting);
	return { row, close, spaces: () => options.map(({ text }) => text) };
}

/** The settings as they open. `confirmed`, the address connected to before, is the address saved unless a test says otherwise, as for a vault that has connected. */
function openTab(connection: { queryUrl: string; secretName: string; space?: string; confirmed?: string }, held: Record<string, string> = {}) {
	const plugin = {
		connection: { space: "", sendEdits: false, confirmed: connection.queryUrl, ...connection },
		connected: () => queryAddress(plugin.connection.queryUrl) !== null && plugin.connection.queryUrl === plugin.connection.confirmed,
		confirm: (address: string) => {
			plugin.connection.confirmed = address;
		},
		settings: { intervalMinutes: 5, sync: { space: Object.keys(held).length > 0 ? "garden" : null, revision: null, files: held, opened: {}, refused: {} } },
		saveConnection: () => {},
		clearOutbox: () => {},
		syncNow: async () => {},
		forgetAddresses: () => {},
		addresses: (text: string) => resolveAddresses(text, stub.http as Http),
	};
	const app = { secretStorage: { getSecret: (name: string) => (name === "fold" ? TOKEN : null) } };
	const tab = new FoldSettingTab(app as never, plugin as never);
	opened.push(tab);
	return { tab, plugin, ...drawRow(tab) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});
/** Every tab a test opened, closed after it, so no timer of one test asks Fold during the next. */
const opened: InstanceType<typeof FoldSettingTab>[] = [];
afterEach(() => {
	for (const tab of opened.splice(0)) tab.hide();
	vi.useRealTimers();
});

const connect = (row: { buttons: Map<string, () => unknown> }) => row.buttons.get("Connect")?.();

describe("the Space row", () => {
	it("says what is missing when the settings open, and asks Fold nothing", () => {
		const { sent } = fold();
		const { row, spaces } = openTab({ queryUrl: "", secretName: "" });
		expect(row.desc).toMatch(/^Enter Fold's address above\./);
		expect(spaces()).toEqual(["Choose a space"]);
		expect(sent).toEqual([]);
	});

	it("lists the spaces as soon as the token is chosen, for the address saved when the settings opened", async () => {
		fold();
		const { tab, row, spaces } = openTab({ queryUrl: WEB, secretName: "" });
		expect(row.desc).toMatch(/^Choose your token above/);
		await tab.setControlValue("secretName", "fold");
		await vi.waitFor(() => expect(row.desc).toMatch(/^Connected\. Your token reaches 1 space\./));
		expect(spaces()).toEqual(["Choose a space", "Garden notes"]);
	});

	it("asks a typed address, once it has rested, whether it is Fold's web app, and lists the spaces once the person selects Connect", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { sent } = fold();
		const { tab, row, spaces, plugin } = openTab({ queryUrl: "", secretName: "fold" });
		for (const typed of ["https://f", "https://fold.te", WEB]) {
			await tab.setControlValue("queryUrl", typed);
			await vi.advanceTimersByTimeAsync(ADDRESS_PAUSE_MS - 100);
		}
		expect(sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(row.desc).toMatch(/^Fold's web app answered\. Select Connect/));
		expect(sent).toEqual([{ url: `${WEB}/config.json`, auth: undefined }]);
		connect(row);
		await vi.waitFor(() => expect(row.desc).toMatch(/^Connected/));
		expect(sent.filter(({ auth }) => auth !== undefined)).toEqual([{ url: `${QUERY}/v1/spaces`, auth: `Bearer ${TOKEN}` }]);
		expect(spaces()).toEqual(["Choose a space", "Garden notes"]);
		expect(plugin.connection.confirmed).toBe(WEB);
	});

	it("takes the list away as soon as the address changes, so no space is chosen through the new address before it is checked", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fold();
		const { tab, row, spaces } = openTab({ queryUrl: WEB, secretName: "fold" });
		await vi.waitFor(() => expect(spaces()).toEqual(["Choose a space", "Garden notes"]));
		await tab.setControlValue("queryUrl", SQUAT);
		expect(spaces()).toEqual(["Choose a space"]);
		expect(row.desc).toMatch(/^Connecting to Fold/);
	});

	it("shows only the newest answer, though an older one comes last", async () => {
		const { release } = fold();
		const { tab, row, spaces } = openTab({ queryUrl: SLOW, secretName: "fold" });
		expect(row.desc).toMatch(/^Connecting to Fold/);
		await tab.setControlValue("queryUrl", WEB);
		await vi.waitFor(() => expect(row.desc).toMatch(/^Fold's web app answered/), { timeout: ADDRESS_PAUSE_MS * 3 });
		release();
		await settle();
		expect(row.desc).toMatch(/^Fold's web app answered/);
		expect(spaces()).toEqual(["Choose a space"]);
	});

	it("keeps the space this device chose, even when Fold no longer lists it, and says so", async () => {
		fold();
		const { row, spaces } = openTab({ queryUrl: WEB, secretName: "fold", space: "gone" });
		await vi.waitFor(() => expect(row.desc).toMatch(/^Connected, but your token cannot reach the space chosen here\./));
		expect(spaces()).toEqual(["Choose a space", "gone", "Garden notes"]);
		expect(row.value).toBe("gone");
	});

	it("shows one answer in every row Obsidian has drawn, as for its settings search", async () => {
		fold();
		const { tab, row } = openTab({ queryUrl: WEB, secretName: "" });
		const second = drawRow(tab);
		await tab.setControlValue("secretName", "fold");
		await vi.waitFor(() => expect([row.desc, second.row.desc].every((desc) => desc.startsWith("Connected"))).toBe(true));
	});

	it("is not drawn while the vault holds notes, and an address typed then asks Fold nothing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { sent } = fold();
		const { tab, row } = openTab({ queryUrl: WEB, secretName: "fold" }, { "managed/a.md": "0".repeat(64) });
		expect([...row.buttons.keys()]).toEqual(["Disconnect"]);
		await tab.setControlValue("queryUrl", SLOW);
		await vi.advanceTimersByTimeAsync(ADDRESS_PAUSE_MS * 2);
		expect(sent).toEqual([]);
	});
});

describe("where the token goes from the settings", () => {
	it("is never an address typed since the settings opened, whatever its /config.json says, until the person selects Connect", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { sent, withToken } = fold();
		const { tab, row } = openTab({ queryUrl: "", secretName: "fold" });
		await tab.setControlValue("queryUrl", PARKED);
		await vi.advanceTimersByTimeAsync(ADDRESS_PAUSE_MS);
		await vi.waitFor(() => expect(row.desc).toMatch(/^This address is not Fold's web app\./));
		await tab.setControlValue("queryUrl", SQUAT);
		await vi.advanceTimersByTimeAsync(ADDRESS_PAUSE_MS);
		await vi.waitFor(() => expect(row.desc).toMatch(/^Fold's web app answered/));
		expect(sent).toEqual([
			{ url: `${PARKED}/config.json`, auth: undefined },
			{ url: `${SQUAT}/config.json`, auth: undefined },
		]);
		expect(withToken()).toEqual([]);
	});

	it("is not a typed address when the token changes before the address has rested", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { withToken } = fold();
		const { tab, row } = openTab({ queryUrl: "", secretName: "" });
		await tab.setControlValue("queryUrl", SQUAT);
		await tab.setControlValue("secretName", "fold");
		await vi.advanceTimersByTimeAsync(ADDRESS_PAUSE_MS * 2);
		await vi.waitFor(() => expect(row.desc).toMatch(/^Fold's web app answered/));
		expect(withToken()).toEqual([]);
	});

	it("is not a typed address once the tab redraws, as Disconnect makes it: only opening the settings, or Connect, trusts one", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { withToken } = fold();
		const { tab } = openTab({ queryUrl: "", secretName: "fold" });
		await tab.setControlValue("queryUrl", SQUAT);
		const redrawn = drawRow(tab);
		await vi.advanceTimersByTimeAsync(ADDRESS_PAUSE_MS * 2);
		await vi.waitFor(() => expect(redrawn.row.desc).toMatch(/^Fold's web app answered/));
		expect(withToken()).toEqual([]);
	});

	it("is not a typed address after the person leaves for another settings tab and comes back", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { withToken } = fold();
		const { tab } = openTab({ queryUrl: "", secretName: "fold" });
		await tab.setControlValue("queryUrl", SQUAT);
		await vi.advanceTimersByTimeAsync(ADDRESS_PAUSE_MS * 2);
		tab.hide();
		const back = drawRow(tab);
		await vi.advanceTimersByTimeAsync(ADDRESS_PAUSE_MS);
		await vi.waitFor(() => expect(back.row.desc).toMatch(/^Fold's web app answered/));
		expect(withToken()).toEqual([]);
	});

	it("is an address the person selected Connect for once, but it is not connected to unless Fold listed their spaces there", async () => {
		const { withToken } = fold();
		const { tab, row, plugin } = openTab({ queryUrl: "", secretName: "fold" });
		await tab.setControlValue("queryUrl", PARKED);
		connect(row);
		await vi.waitFor(() => expect(row.desc).toMatch(/^Not connected\. This address did not answer as Fold does/));
		expect(withToken().map(({ url }) => url)).toEqual([`${PARKED}/v1/spaces`]);
		expect(plugin.connection.confirmed).toBe("");
	});

	it("is the address connected to, as a round sends it, so Fold's query address from 0.1, saved before Connect existed, still lists spaces", async () => {
		fold();
		const { tab, row } = openTab({ queryUrl: QUERY, secretName: "" });
		await tab.setControlValue("secretName", "fold");
		await vi.waitFor(() => expect(row.desc).toMatch(/^Connected\. Your token reaches 1 space\. This address only copies notes/));
	});

	it("is an address the person connected to, from then on, as the token changes", async () => {
		fold();
		const { tab, row } = openTab({ queryUrl: "", secretName: "fold" });
		await tab.setControlValue("queryUrl", WEB);
		connect(row);
		await vi.waitFor(() => expect(row.desc).toMatch(/^Connected/));
		await tab.setControlValue("secretName", "");
		await tab.setControlValue("secretName", "fold");
		await vi.waitFor(() => expect(row.desc).toMatch(/^Connected/));
	});

	it("is nowhere once the settings close: the wait for the address to rest is dropped, and so is a question on its way", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { sent, withToken, release } = fold();
		const { tab, row } = openTab({ queryUrl: SLOW, secretName: "fold" });
		await tab.setControlValue("queryUrl", WEB);
		tab.hide();
		await vi.advanceTimersByTimeAsync(ADDRESS_PAUSE_MS * 2);
		vi.useRealTimers();
		release();
		await settle();
		expect(sent.map(({ url }) => url)).toEqual([`${SLOW}/config.json`]);
		expect(withToken()).toEqual([]);
		expect(row.desc).toMatch(/^Connecting to Fold/);
	});

	it("is nowhere once the last row is gone, though its question was asked", async () => {
		const { withToken, release } = fold();
		const { row, close } = openTab({ queryUrl: SLOW, secretName: "fold" });
		close();
		release();
		await settle();
		expect(withToken()).toEqual([]);
		expect(row.desc).toMatch(/^Connecting to Fold/);
	});
});
