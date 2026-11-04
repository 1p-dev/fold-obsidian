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
		registerInterval(timer: number) {
			return timer;
		}
	}
	return {
		Plugin,
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
vi.mock("./vault-store", () => ({
	VaultStore: class {
		constructor() {
			// biome-ignore lint/correctness/noConstructorReturn: a test's stand-in
			return stub.store as Store;
		}
	},
}));

const { default: FoldMemoryPlugin, CONNECTION_KEY } = await import("./main");

const QUERY = "https://query.fold.test";
const TOKEN = "a-secret-token"; // secret-scan-ok: a stand-in the tests look for

interface Stubbed {
	saved: string[];
	dataFile: unknown;
}

function setup(options: { dataFile?: unknown; connection?: unknown; files?: Record<string, string>; indexDelayMs?: number } = {}) {
	const api = createMockApi({ ...(options.indexDelayMs === undefined ? {} : { indexDelayMs: options.indexDelayMs }), spaces: [{ id: "garden", organization: { id: "o", name: "O" }, access: "admin", files: options.files ?? { "PURPOSE.md": "# G\n", "inbox/a.md": "a\n", "managed/b.md": "b\n" } }] });
	const requests: { url: string; auth: string | undefined }[] = [];
	let gate: Promise<void> | null = null;
	const http: Http = async (request) => {
		requests.push({ url: request.url, auth: request.headers.authorization });
		if (gate && request.url.includes("/content/")) await gate;
		const answer = await api.handle(new Request(request.url, { method: request.method, headers: request.headers }));
		return { status: answer.status, headers: Object.fromEntries(answer.headers), arrayBuffer: await answer.arrayBuffer() };
	};
	stub.http = http;
	const store = new MemoryStore();
	stub.store = store;
	const local = new Map<string, unknown>(options.connection === undefined ? [] : [[CONNECTION_KEY, options.connection]]);
	const secretsRead: string[] = [];
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
		holdReads: () => {
			let open = () => {};
			gate = new Promise((resolve) => {
				open = resolve;
			});
			return () => open();
		},
	};
}

const connection = { queryUrl: QUERY, secretName: "fold-token", space: "garden" };

beforeEach(() => {
	stub.notices.length = 0;
	stub.updates = 0;
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
		expect(requests.length).toBeGreaterThan(0);
		expect(requests.every((request) => request.url.startsWith(`${QUERY}/v1/spaces/garden`))).toBe(true);
		expect(requests.every((request) => request.auth === `Bearer ${TOKEN}`)).toBe(true);
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
		expect(local.get(CONNECTION_KEY)).toEqual(connection);
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
		plugin.settings.sync = { space: null, revision: null, files: {}, opened: {} };
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
