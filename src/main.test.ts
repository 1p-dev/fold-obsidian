/** The plugin class around a round, over a stub of Obsidian: where a token may go, and a round that a person overtakes. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "./api/mock";
import type { Http } from "./fold";
import type { Store } from "./sync";
import { MemoryStore } from "./test-support";

const stub = vi.hoisted(() => ({
	notices: [] as string[],
	http: (async () => {
		throw new Error("no http yet");
	}) as unknown,
	store: null as unknown,
	updates: 0,
	bar: "",
	/** The link handler the plugin registered, by action. */
	links: new Map<string, (params: Record<string, string>) => unknown>(),
	/** What the link's question showed, and its Connect button. */
	asked: [] as { title: string; organisation: string; connect: () => void }[],
	settingsOpened: [] as string[],
}));

vi.mock("obsidian", () => {
	class Plugin {
		saved: string[] = [];
		dataFile: unknown = null;
		constructor(readonly app: unknown) {}
		async loadData() {
			return this.dataFile;
		}
		async saveData(data: unknown) {
			this.saved.push(JSON.stringify(data));
		}
		addStatusBarItem() {
			return {
				setText(text: string) {
					stub.bar = text;
				},
			};
		}
		addRibbonIcon() {}
		addCommand() {}
		addSettingTab() {}
		registerEvent() {}
		register() {}
		registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown) {
			stub.links.set(action, handler);
		}
		registerInterval(timer: number) {
			return timer;
		}
	}
	return {
		Plugin,
		TFile: class {
			constructor(readonly path: string) {}
		},
		MarkdownView: class {},
		Notice: class {
			constructor(message: string) {
				stub.notices.push(message);
			}
		},
		normalizePath: (path: string) => path,
		requestUrl: (request: unknown) => (stub.http as (r: unknown) => unknown)(request),
	};
});
vi.mock("./settings", () => ({
	FoldSettingTab: class {
		update() {
			stub.updates += 1;
		}
	},
}));
vi.mock("./link-modal", () => ({
	ConnectModal: class {
		constructor(_app: unknown, title: string, organisation: string, connect: () => void) {
			stub.asked.push({ title, organisation, connect });
		}
		open() {}
	},
}));
vi.mock("./vault-store", () => ({
	VaultStore: class {
		constructor(_app: unknown, written?: (path: string, bytes: Uint8Array) => void) {
			(stub.store as MemoryStore).written = written;
			// biome-ignore lint/correctness/noConstructorReturn: a test's stand-in
			return stub.store as Store;
		}
	},
}));

const { default: FoldMemoryPlugin, CONNECTION_KEY, OUTBOX_KEY, QUIET_MS } = await import("./main");
const { TFile } = await import("obsidian");

const QUERY = "https://query.fold.test";
const TOKEN = "a-secret-token"; // secret-scan-ok: a stand-in the tests look for

interface Stubbed {
	saved: string[];
	dataFile: unknown;
}

function setup(options: { dataFile?: unknown; connection?: unknown; files?: Record<string, string>; indexDelayMs?: number; webApp?: boolean } = {}) {
	const api = createMockApi({ ...(options.indexDelayMs === undefined ? {} : { indexDelayMs: options.indexDelayMs }), spaces: [{ id: "garden", organization: { id: "o", name: "O" }, access: "admin", files: options.files ?? { "PURPOSE.md": "# G\n", "inbox/a.md": "a\n", "managed/b.md": "b\n" } }] });
	const requests: { url: string; auth: string | undefined }[] = [];
	let gate: Promise<void> | null = null;
	const http: Http = async (request) => {
		requests.push({ url: request.url, auth: request.headers.authorization });
		// The query address doubles as Fold's web app when a test asks, naming itself for both parts.
		if (request.url === `${QUERY}/config.json`) {
			const config = options.webApp ? JSON.stringify({ queryUrl: QUERY, controlUrl: QUERY }) : '{"error":"not-found"}';
			return { status: options.webApp ? 200 : 404, headers: {}, arrayBuffer: new TextEncoder().encode(config).buffer as ArrayBuffer };
		}
		if (gate && request.url.includes("/content/")) await gate;
		const answer = await api.handle(new Request(request.url, { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) }));
		return { status: answer.status, headers: Object.fromEntries(answer.headers), arrayBuffer: await answer.arrayBuffer() };
	};
	stub.http = http;
	const store = new MemoryStore();
	stub.store = store;
	const local = new Map<string, unknown>(options.connection === undefined ? [] : [[CONNECTION_KEY, options.connection]]);
	const secretsRead: string[] = [];
	const folders = new Set<string>();
	const app = {
		loadLocalStorage: (key: string) => local.get(key) ?? null,
		saveLocalStorage: (key: string, value: unknown) => local.set(key, value),
		secretStorage: {
			getSecret: (name: string) => {
				secretsRead.push(name);
				return name === "fold-token" ? TOKEN : name === "another-plugins-key" ? "ANOTHER-PLUGINS-SECRET" : null;
			},
		},
		workspace: { on: () => ({}), onLayoutReady: () => {}, getActiveViewOfType: () => null },
		setting: { open: () => stub.settingsOpened.push("settings"), openTabById: (id: string) => stub.settingsOpened.push(id) },
		vault: {
			readBinary: async (file: { path: string }) => ((await store.read(file.path)) ?? new Uint8Array()).slice().buffer,
			getAbstractFileByPath: (path: string) => (folders.has(path) ? { path } : null),
			createFolder: async (path: string) => {
				folders.add(path);
			},
		},
	};
	const plugin = new (FoldMemoryPlugin as unknown as new (app: unknown) => InstanceType<typeof FoldMemoryPlugin> & Stubbed)(app);
	plugin.dataFile = options.dataFile ?? null;
	return {
		plugin,
		api,
		store,
		requests,
		secretsRead,
		local,
		folders,
		holdReads: () => {
			let open = () => {};
			gate = new Promise((resolve) => {
				open = resolve;
			});
			return () => open();
		},
	};
}

const connection = { queryUrl: QUERY, secretName: "fold-token", space: "garden", sendEdits: false };

beforeEach(() => {
	stub.notices.length = 0;
	stub.updates = 0;
	stub.links.clear();
	stub.asked.length = 0;
	stub.settingsOpened.length = 0;
	vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => {}, setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) });
});

describe("where a token goes", () => {
	it("is never decided by a vault's saved data: a planted address, secret's name and space are ignored", async () => {
		const { plugin, requests, secretsRead } = setup({ dataFile: { queryUrl: "https://evil.example", secretName: "another-plugins-key", space: "garden" } });
		await plugin.onload();
		await plugin.syncNow(true);
		expect(requests).toEqual([]);
		expect(secretsRead).toEqual([]);
	});

	it("is the address set on this device, even when the vault's saved data names another", async () => {
		const { plugin, requests } = setup({ dataFile: { queryUrl: "https://evil.example", secretName: "another-plugins-key", space: "someone-elses-private-space" }, connection });
		await plugin.onload();
		await plugin.syncNow(true);
		// The address is asked once whether it is Fold's web app, with no token, and every call to Fold's API goes to it, with the token.
		const calls = requests.filter((request) => !request.url.endsWith("/config.json"));
		expect(requests.filter((request) => request.url.endsWith("/config.json"))).toEqual([{ url: `${QUERY}/config.json`, auth: undefined }]);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((request) => request.url.startsWith(`${QUERY}/v1/spaces/garden`))).toBe(true);
		expect(calls.every((request) => request.auth === `Bearer ${TOKEN}`)).toBe(true);
	});

	it("leaves no trace in what is saved in the vault: not the token, its name, nor the address", async () => {
		const { plugin } = setup({ connection });
		await plugin.onload();
		await plugin.syncNow(true);
		expect(plugin.saved.length).toBeGreaterThan(0);
		for (const saved of plugin.saved) {
			expect(saved).not.toContain(TOKEN);
			expect(saved).not.toContain("fold-token");
			expect(saved).not.toContain("query.fold.test");
			expect(Object.keys(JSON.parse(saved)).sort()).toEqual(["intervalMinutes", "sync"]);
		}
	});

	it("is kept on this device when a person sets it, and not in the vault", async () => {
		const { plugin, local } = setup();
		await plugin.onload();
		plugin.connection.queryUrl = QUERY;
		plugin.connection.secretName = "fold-token";
		plugin.connection.space = "garden";
		plugin.saveConnection();
		expect(local.get(CONNECTION_KEY)).toEqual({ ...connection, confirmed: "" });
		expect(plugin.saved).toEqual([]);
	});
});

describe("a round a person overtakes", () => {
	it("does not bring back what they disconnected from, and changes nothing more", async () => {
		const { plugin, store, holdReads } = setup({ connection });
		await plugin.onload();
		const open = holdReads();
		const round = plugin.syncNow(true);
		await vi.waitFor(() => expect(plugin.settings.sync).toBeDefined());
		await new Promise((resolve) => setTimeout(resolve, 20));
		plugin.settings.sync = { space: null, revision: null, files: {}, opened: {}, refused: {} };
		plugin.connection.space = "";
		open();
		await round;
		expect(plugin.settings.sync.files).toEqual({});
		expect(plugin.settings.sync.space).toBeNull();
		expect(store.log.filter((entry) => entry.startsWith("trash"))).toEqual([]);
	});

	it("does not overwrite the state of a newly chosen space", async () => {
		const { plugin, holdReads } = setup({ connection: { ...connection } });
		await plugin.onload();
		const open = holdReads();
		const round = plugin.syncNow(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		plugin.connection.space = "another";
		open();
		await round;
		expect(plugin.settings.sync.space).toBeNull();
	});

	it("still saves what it did when Obsidian closes part way, so those notes are not orphaned", async () => {
		const { plugin, store, holdReads } = setup({ connection });
		await plugin.onload();
		const open = holdReads();
		const round = plugin.syncNow(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		plugin.onunload();
		open();
		await round;
		const notesOnDisk = [...store.files.keys()];
		expect(notesOnDisk.length).toBeGreaterThan(0);
		expect(Object.keys(plugin.settings.sync.files).sort()).toEqual(notesOnDisk.sort());
		expect(plugin.settings.sync.revision).toBeNull();
		expect(JSON.parse(plugin.saved.at(-1) ?? "{}").sync.files).toEqual(plugin.settings.sync.files);
		// And nothing more is shown or asked of Fold, such as the settings tab listing spaces once more.
		expect(stub.updates).toBe(0);
		expect(stub.notices).toEqual([]);
	});
});

describe("what goes wrong", () => {
	it("is said, and a later round still runs, when saving fails", async () => {
		const { plugin, requests } = setup({ connection });
		await plugin.onload();
		plugin.saveData = async () => {
			throw new Error("the disk is full");
		};
		await plugin.syncNow(true);
		expect(stub.notices.join()).toContain("the disk is full");
		const before = requests.length;
		await plugin.syncNow(true);
		expect(requests.length).toBeGreaterThan(before);
	});

	it("is said once on a timer, not every few minutes", async () => {
		const { plugin } = setup({ connection: { queryUrl: QUERY, secretName: "no-such-secret", space: "garden" } });
		await plugin.onload();
		await plugin.syncNow(false);
		await plugin.syncNow(false);
		expect(stub.notices).toHaveLength(1);
		expect(stub.notices[0]).toContain("token");
	});

	it("says notes are on their way, not that a space has none, while Fold indexes them", async () => {
		const { plugin, api } = setup({ connection, indexDelayMs: 3_600_000, files: { "PURPOSE.md": "# G\n" } });
		await api.handle(new Request(`${QUERY}/v1/spaces/garden/files/inbox/a.md`, { method: "PUT", headers: { authorization: "Bearer t" }, body: JSON.stringify({ text: "a\n" }) }));
		await plugin.onload();
		await plugin.syncNow(false);
		expect(stub.bar).toBe("Fold: 0 notes, 1 being indexed");
		expect(stub.notices).toEqual([]);
		await plugin.syncNow(true);
		expect(stub.notices).toEqual(["Fold: 1 note still being indexed."]);
		api.finishIndexing();
		await plugin.syncNow(false);
		expect(stub.bar).toBe("Fold: 1 note");
	});

	it("says a space has no notes to copy, rather than failing", async () => {
		const { plugin } = setup({ connection, files: { "PURPOSE.md": "# G\n", "reference/a.md": "a\n" } });
		await plugin.onload();
		await plugin.syncNow(true);
		expect(stub.notices).toEqual(["Fold: this space has no notes to copy."]);
	});
});

describe("the status bar", () => {
	it("says the plugin is not set up, not connected, or that a space is still to choose, rather than nothing", async () => {
		const { plugin, requests } = setup();
		await plugin.onload();
		stub.bar = "";
		await plugin.syncNow(false);
		expect(stub.bar).toBe("Fold: not set up");
		plugin.connection.queryUrl = QUERY;
		plugin.connection.secretName = "fold-token";
		plugin.saveConnection();
		expect(stub.bar).toBe("Fold: not connected");
		plugin.confirm(QUERY);
		expect(stub.bar).toBe("Fold: choose a space");
		await plugin.syncNow(false);
		expect(stub.bar).toBe("Fold: choose a space");
		expect(requests).toEqual([]);
		plugin.connection.space = "garden";
		plugin.saveConnection();
		// Set up now: it stops saying otherwise, and the next round says what the vault holds.
		expect(stub.bar).toBe("Fold");
		await plugin.syncNow(false);
		expect(stub.bar).toBe("Fold: 2 notes");
	});

	it("says a vault that holds notes is not set up on this device, since it offers no space to choose", async () => {
		const { plugin } = setup({ connection: { ...connection, space: "", confirmed: QUERY } });
		await plugin.onload();
		plugin.settings.sync = { space: "garden", revision: "1", files: { "managed/b.md": "0".repeat(64) }, opened: {}, refused: {} };
		await plugin.syncNow(false);
		expect(stub.bar).toBe("Fold: not set up");
	});
});

describe("an address the person has not connected to", () => {
	it("is sent nothing by a round, which says what to do when asked, and the round runs once they connect", async () => {
		const { plugin, requests } = setup({ connection: { ...connection, queryUrl: "https://query.fold.te", confirmed: QUERY } });
		await plugin.onload();
		await plugin.syncNow(false);
		await plugin.syncNow(true);
		expect(requests).toEqual([]);
		expect(stub.bar).toBe("Fold: not connected");
		expect(stub.notices).toEqual(["Fold: select Connect in this plugin's settings, so your token goes to that address."]);
		plugin.connection.queryUrl = QUERY;
		plugin.saveConnection();
		await plugin.syncNow(false);
		expect(requests.length).toBeGreaterThan(0);
	});

	it("is sent nothing by a link from Fold's web app, which opens the settings instead", async () => {
		const { plugin, requests } = setup({ connection: { ...connection, space: "", queryUrl: "https://query.fold.te", confirmed: QUERY } });
		(plugin as unknown as { manifest: { id: string } }).manifest = { id: "fold-memory" };
		await plugin.onload();
		await plugin.openLink({ action: "fold-memory", space: "garden" });
		expect(requests).toEqual([]);
		expect(stub.settingsOpened).toEqual(["settings", "fold-memory"]);
		expect(stub.notices[0]).toContain("select Connect");
	});
});

describe("what a person changes, with sending on", () => {
	const sending = { ...connection, sendEdits: true };
	/** What Obsidian reports when a file changes, as the plugin hears it. */
	/** What Obsidian reports when a file changes, or is `created` here, as the plugin hears it. */
	const changed = (plugin: unknown, path: string, created = false) => (plugin as { changedHere(file: unknown, created: boolean): Promise<void> }).changedHere(new (TFile as unknown as new (path: string) => unknown)(path), created);

	it("is kept on this device until it is sent, and the plugin's own copies are not taken for changes", async () => {
		const { plugin, store, api, local } = setup({ connection: sending, webApp: true });
		await plugin.onload();
		await plugin.syncNow(true);
		await changed(plugin, "managed/b.md");
		expect(plugin.outbox).toEqual({});
		store.put("inbox/a.md", "a, edited\n");
		await changed(plugin, "inbox/a.md");
		expect(Object.keys(local.get(OUTBOX_KEY) as object)).toEqual(["inbox/a.md"]);
		stub.notices.length = 0;
		await plugin.syncNow(true);
		expect(api.headFiles("garden")?.["inbox/a.md"]).toBe("a, edited\n");
		expect(stub.notices).toEqual(["Fold: your edits to inbox/a.md sent."]);
		expect(plugin.outbox).toEqual({});
		expect(local.get(OUTBOX_KEY)).toEqual({});
		for (const saved of plugin.saved) expect(saved).not.toContain("outbox");
	});

	it("goes on a timer only once the note has been quiet for a while", async () => {
		const { plugin, store, api } = setup({ connection: sending, webApp: true });
		await plugin.onload();
		await plugin.syncNow(true);
		store.put("inbox/a.md", "a, being written\n");
		await changed(plugin, "inbox/a.md");
		await plugin.syncNow(false);
		expect(api.headFiles("garden")?.["inbox/a.md"]).toBe("a\n");
		plugin.outbox["inbox/a.md"] = { at: Date.now() - 2 * QUIET_MS, created: false };
		await plugin.syncNow(false);
		expect(api.headFiles("garden")?.["inbox/a.md"]).toBe("a, being written\n");
	});

	it("is not kept at all with sending off", async () => {
		const { plugin, store } = setup({ connection });
		await plugin.onload();
		await plugin.syncNow(true);
		store.put("inbox/a.md", "a, edited\n");
		await changed(plugin, "inbox/a.md");
		expect(plugin.outbox).toEqual({});
	});

	it("is not sent through an address that names only Fold's query part, and the person is told how to send", async () => {
		const { plugin, store, api, requests } = setup({ connection: sending });
		await plugin.onload();
		await plugin.syncNow(true);
		store.put("inbox/a.md", "a, edited\n");
		await changed(plugin, "inbox/a.md");
		stub.notices.length = 0;
		await plugin.syncNow(true);
		expect(api.headFiles("garden")?.["inbox/a.md"]).toBe("a\n");
		expect(requests.every((request) => !request.url.includes("/files/inbox/a.md"))).toBe(true);
		expect(stub.notices[0]).toContain("web app");
		expect(plugin.outbox["inbox/a.md"]).toBeDefined();
	});

	it("is forgotten when sending is turned on, so nothing from before is sent, and when the vault is disconnected", async () => {
		const { plugin, folders } = setup({ connection: sending, webApp: true });
		await plugin.onload();
		plugin.outbox = { "inbox/old.md": { at: 1, created: true } };
		plugin.setSending(true);
		expect(plugin.outbox).toEqual({});
		// And the vault has an inbox to write a new note in.
		await vi.waitFor(() => expect(folders.has("inbox")).toBe(true));
		plugin.outbox = { "inbox/a.md": { at: 1, created: false } };
		plugin.clearOutbox();
		expect(plugin.outbox).toEqual({});
	});

	it("counts a file it does not hold only once it was made here, never one Obsidian only rewrote", async () => {
		const { plugin, store } = setup({ connection: sending, webApp: true });
		await plugin.onload();
		await plugin.syncNow(true);
		store.put("inbox/came-with-the-vault.md", "# Someone else's\n");
		await changed(plugin, "inbox/came-with-the-vault.md");
		expect(plugin.outbox).toEqual({});
		store.put("inbox/mine.md", "# Mine\n");
		await changed(plugin, "inbox/mine.md", true);
		await changed(plugin, "inbox/mine.md");
		expect(plugin.outbox["inbox/mine.md"]?.created).toBe(true);
	});

	it("never takes what a round wrote for a person's change, though the saved state has yet to hold it", async () => {
		const { plugin } = setup({ connection: sending, webApp: true });
		await plugin.onload();
		await plugin.syncNow(true);
		// As during a round, before its state is saved.
		plugin.settings.sync = { space: null, revision: null, files: {}, opened: {}, refused: {} };
		await changed(plugin, "managed/b.md", true);
		await changed(plugin, "inbox/a.md");
		expect(plugin.outbox).toEqual({});
	});
});

describe("a link from Fold's web app", () => {
	const fresh = { ...connection, space: "", sendEdits: true, confirmed: QUERY };
	/** A confirmed link starts a round: wait for it, so its words do not land in the next test. */
	const roundDone = (plugin: unknown) => vi.waitFor(() => expect((plugin as { running: boolean }).running).toBe(false));
	const open = async (space: string | undefined) => {
		const handler = stub.links.get("fold-memory");
		expect(handler).toBeDefined();
		// Obsidian does not wait on a link's handler, so the test waits for what it does: say something, ask, or open the settings.
		const before = stub.notices.length + stub.asked.length + stub.settingsOpened.length;
		handler!({ action: "fold-memory", ...(space === undefined ? {} : { space }) });
		await vi.waitFor(() => expect(stub.notices.length + stub.asked.length + stub.settingsOpened.length).toBeGreaterThan(before));
	};

	it("names only a space, and anything else is refused with nothing done", async () => {
		const { plugin, requests } = setup({ connection: fresh, webApp: true });
		(plugin as unknown as { manifest: { id: string } }).manifest = { id: "fold-memory" };
		await plugin.onload();
		for (const space of [undefined, "", "../garden", "Garden", "garden?x=1", "a".repeat(101)]) await open(space);
		expect(stub.asked).toEqual([]);
		expect(requests).toEqual([]);
		expect(plugin.connection.space).toBe("");
		expect(stub.notices.every((notice) => notice === "Fold: this link does not name a space.")).toBe(true);
	});

	it("opens the settings and says why when the plugin is not set up, and signs no one in", async () => {
		const { plugin, requests } = setup({ connection: { ...fresh, secretName: "" } });
		(plugin as unknown as { manifest: { id: string } }).manifest = { id: "fold-memory" };
		await plugin.onload();
		await open("garden");
		expect(stub.settingsOpened).toEqual(["settings", "fold-memory"]);
		expect(stub.notices[0]).toContain("settings");
		expect(stub.asked).toEqual([]);
		expect(requests).toEqual([]);
		expect(plugin.connection.space).toBe("");
	});

	it("asks first, naming the space as Fold reports it through the person's own address and token, and changes nothing until they confirm", async () => {
		const { plugin, requests, store } = setup({ connection: fresh, webApp: true });
		await plugin.onload();
		await open("garden");
		expect(stub.asked.map(({ title, organisation }) => ({ title, organisation }))).toEqual([{ title: "G", organisation: "O" }]);
		expect(requests.filter((request) => !request.url.endsWith("/config.json")).every((request) => request.url === `${QUERY}/v1/spaces` && request.auth === `Bearer ${TOKEN}`)).toBe(true);
		expect(plugin.connection.space).toBe("");
		expect(store.files.size).toBe(0);
		stub.asked[0]!.connect();
		await roundDone(plugin);
		expect(store.files.size).toBe(2);
		expect(plugin.connection.space).toBe("garden");
	});

	it("starts a space chosen this way with sending off, so a page cannot pick where a person's notes go", async () => {
		const { plugin } = setup({ connection: fresh, webApp: true });
		await plugin.onload();
		plugin.outbox = { "inbox/waiting.md": { at: 1, created: true } };
		await open("garden");
		stub.asked[0]!.connect();
		await roundDone(plugin);
		expect(plugin.connection.space).toBe("garden");
		expect(plugin.connection.sendEdits).toBe(false);
		expect(plugin.outbox).toEqual({});
	});

	it("never switches a vault that holds notes, whether of another space or of this one", async () => {
		const { plugin, requests } = setup({ connection, webApp: true });
		await plugin.onload();
		await plugin.syncNow(false);
		const before = requests.length;
		stub.notices.length = 0;
		await open("another-space");
		await open("garden");
		expect(stub.asked).toEqual([]);
		expect(requests.length).toBe(before);
		expect(stub.notices).toEqual(["Fold: this vault holds another space's notes. Disconnect in this plugin's settings first, or open the link in another vault.", "Fold: this vault already holds that space."]);
		expect(plugin.connection.space).toBe("garden");
	});

	it("says so when the person's token cannot reach the space, and asks nothing", async () => {
		const { plugin } = setup({ connection: fresh, webApp: true });
		await plugin.onload();
		await open("someone-elses-space");
		expect(stub.asked).toEqual([]);
		expect(stub.notices).toEqual(["Fold: your token can't reach that space, or there is no such space."]);
	});
});
