/** The plugin: settings, a timer and a command around one sync, and notes shown as read-only. */
import { MarkdownView, normalizePath, Notice, type ObsidianProtocolData, Plugin, requestUrl, type TAbstractFile, TFile, type WorkspaceLeaf } from "obsidian";
import { type Addresses, foldClient, queryAddress, resolveAddresses } from "./fold";
import { sha256 } from "./hash";
import { ConnectModal } from "./link-modal";
import { isNote, localForm } from "./notes";
import { type Connection, DEFAULT_INTERVAL_MINUTES, type OutboxEntry, parseConnection, parseOutbox, parseSaved, type Saved } from "./saved";
import { FoldSettingTab } from "./settings";
import { NOTHING_YET, syncSpace } from "./sync";
import { VaultStore } from "./vault-store";
import { describeHeld, describeRefusal, describeRound, saidBy } from "./words";

/** The key of the address and the secret's name in Obsidian's per-vault local storage. */
export const CONNECTION_KEY = "fold-memory-connection";
/** The key of what a person changed here while sending was on, in the same storage, so a vault never decides what is sent. */
export const OUTBOX_KEY = "fold-memory-outbox";
/** A change goes once a note has been left this long, so a note being written is sent once it is finished, not at every save. */
export const QUIET_MS = 60_000;
/** The action of the link Fold's web app shows on a space: `obsidian://fold-memory?space=<id>`. */
export const LINK_ACTION = "fold-memory";
/** A space's id as Fold makes them, and nothing a link could use to reach anything else. */
const SPACE_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

const NO_NOTES = "Fold: this space has no notes to copy.";

export default class FoldMemoryPlugin extends Plugin {
	override settings: Saved = { intervalMinutes: DEFAULT_INTERVAL_MINUTES, sync: NOTHING_YET };
	connection: Connection = { queryUrl: "", secretName: "", space: "", sendEdits: false };
	/** What a person changed here while sending was on, by the vault's path. */
	outbox: Record<string, OutboxEntry> = {};
	/** What a round wrote, by the vault's path, so the events its writes raise are not taken for a person's. */
	private readonly ownWrites = new Map<string, Uint8Array>();
	private found: { text: string; addresses: Addresses } | null = null;
	private soon: number | null = null;
	private saidNoControl = false;
	private tab: FoldSettingTab | null = null;
	private statusBar: HTMLElement | null = null;
	private timer: number | null = null;
	private running = false;
	private stopping = false;
	private lastProblem: string | null = null;
	private alreadySaid: ReadonlySet<string> = new Set();

	override async onload(): Promise<void> {
		this.settings = parseSaved(await this.loadData());
		this.connection = parseConnection(this.app.loadLocalStorage(CONNECTION_KEY));
		this.outbox = parseOutbox(this.app.loadLocalStorage(OUTBOX_KEY));
		this.statusBar = this.addStatusBarItem();
		this.addRibbonIcon("refresh-cw", "Fold: sync notes now", () => void this.syncNow(true));
		this.addCommand({ id: "sync-now", name: "Sync notes now", callback: () => void this.syncNow(true) });
		this.registerObsidianProtocolHandler(LINK_ACTION, (params) => void this.openLink(params));
		this.tab = new FoldSettingTab(this.app, this);
		this.addSettingTab(this.tab);
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.showAsRead(leaf)));
		this.registerEvent(this.app.workspace.on("file-open", () => this.showAsRead(this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ?? null)));
		this.register(() => {
			if (this.soon !== null) window.clearTimeout(this.soon);
		});
		this.app.workspace.onLayoutReady(() => {
			// Only once the vault has loaded, since Obsidian reports every file as created while it loads.
			this.registerEvent(this.app.vault.on("modify", (file) => void this.changedHere(file, false)));
			this.registerEvent(this.app.vault.on("create", (file) => void this.changedHere(file, true)));
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					if (this.outbox[oldPath] !== undefined) {
						delete this.outbox[oldPath];
						this.saveOutbox();
					}
					void this.changedHere(file, true);
				}),
			);
			this.schedule();
			void this.ensureInbox();
			void this.syncNow(false);
		});
	}

	override onunload(): void {
		this.stopping = true;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	saveConnection(): void {
		this.app.saveLocalStorage(CONNECTION_KEY, this.connection);
	}

	saveOutbox(): void {
		this.app.saveLocalStorage(OUTBOX_KEY, this.outbox);
	}

	/** What is changed from now on is offered, so nothing a person did before, nor anything a vault came with, is ever sent. */
	setSending(on: boolean): void {
		this.connection.sendEdits = on;
		this.saveConnection();
		this.clearOutbox();
		void this.ensureInbox();
	}

	/** A new note goes in inbox/, so with sending on the vault has one to write in, even when the space's inbox is empty. */
	private async ensureInbox(): Promise<void> {
		if (!this.connection.sendEdits || this.app.vault.getAbstractFileByPath("inbox") !== null) return;
		try {
			await this.app.vault.createFolder("inbox");
		} catch {
			// Made meanwhile, or a file of that name is in the way, which is a person's own.
		}
	}

	/** Changes waiting to be sent are for the space they were made in, so Disconnect, or another space, forgets them. */
	clearOutbox(): void {
		this.outbox = {};
		this.saveOutbox();
	}

	/**
	 * `obsidian://fold-memory?space=<id>`, the link Fold's web app shows on a space. Any page can make such a link, so it carries only a space's id; the person is asked first, about the space as Fold reports it through their own address and token; a vault holding notes is never switched; and a space chosen this way starts with sending off.
	 */
	async openLink(params: ObsidianProtocolData): Promise<void> {
		const id = params.space;
		if (typeof id !== "string" || !SPACE_ID.test(id)) {
			new Notice("Fold: this link does not name a space.");
			return;
		}
		const { queryUrl, secretName } = this.connection;
		// The link never signs anyone in: the person sets the plugin up themselves.
		if (!queryAddress(queryUrl) || !secretName) {
			this.openSettings();
			new Notice("Fold: set the address and your token in this plugin's settings, then open the link again.");
			return;
		}
		if (this.saidHeld(id)) return;
		let found: { title: string; organisation: string } | undefined;
		try {
			const addresses = await this.addresses(queryUrl);
			if (!addresses) return;
			const list = await foldClient(addresses, () => this.app.secretStorage.getSecret(secretName), requestUrl).listSpaces();
			const space = list.spaces.find((candidate) => candidate.id === id);
			if (space) found = { title: space.title, organisation: space.organization.name };
		} catch (error) {
			new Notice(`Fold: ${describeRefusal(error)}`);
			return;
		}
		if (!found) {
			new Notice("Fold: your token can't reach that space, or there is no such space.");
			return;
		}
		new ConnectModal(this.app, found.title, found.organisation, () => void this.connectTo(id)).open();
	}

	/** A vault holds one space, so a link never switches one that holds notes, its own included. */
	private saidHeld(id: string): boolean {
		const { sync } = this.settings;
		if (Object.keys(sync.files).length === 0) return false;
		new Notice(sync.space === id ? "Fold: this vault already holds that space." : "Fold: this vault holds another space's notes. Disconnect in this plugin's settings first, or open the link in another vault.");
		return true;
	}

	/** The space a person confirmed from a link. */
	private async connectTo(id: string): Promise<void> {
		// Notes may have come meanwhile.
		if (this.saidHeld(id)) return;
		this.connection.space = id;
		// Otherwise a page could send a person's next inbox notes to a space it chose: they turn sending on themselves.
		this.setSending(false);
		this.tab?.update();
		await this.syncNow(true);
	}

	private openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	/** Fold's addresses, read from its web app once a session for each address entered. */
	async addresses(text: string): Promise<Addresses | null> {
		if (this.found?.text === text) return this.found.addresses;
		const addresses = await resolveAddresses(text, requestUrl);
		if (addresses) this.found = { text, addresses };
		return addresses;
	}

	/**
	 * A note a person changed, or `created` here. The plugin's own copies raise the same events, so a file holding what this round wrote, or what Fold gave, is not a change. A file the plugin does not hold counts only once it was made here: one already in the vault, or left by a space this vault was disconnected from, or that Obsidian only rewrote on opening it, never becomes a new note.
	 */
	private async changedHere(file: TAbstractFile, created: boolean): Promise<void> {
		if (!this.connection.sendEdits || !(file instanceof TFile) || !isNote(file.path)) return;
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		const ours = this.ownWrites.get(file.path);
		if (ours !== undefined && ours.length === bytes.length && ours.every((byte, at) => byte === bytes[at])) return;
		const { files } = this.settings.sync;
		const held = Object.keys(files).find((path) => localForm(path) === file.path);
		if (held !== undefined && (await sha256(bytes)) === files[held]) return;
		const before = this.outbox[file.path];
		if (held === undefined && !created && !before?.created) return;
		this.outbox[file.path] = { at: Date.now(), created: created || (before?.created ?? false) };
		this.saveOutbox();
		if (this.soon !== null) window.clearTimeout(this.soon);
		this.soon = window.setTimeout(() => {
			this.soon = null;
			void this.syncNow(false);
		}, QUIET_MS + 5_000);
	}

	schedule(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = this.registerInterval(window.setInterval(() => void this.syncNow(false), this.settings.intervalMinutes * 60_000));
	}

	/** A note here is a copy, so it opens for reading unless a person's edits are sent: otherwise an edit would not reach Fold. */
	private showAsRead(leaf: WorkspaceLeaf | null): void {
		if (this.connection.sendEdits) return;
		const view = leaf?.view;
		if (!(view instanceof MarkdownView) || !view.file || view.getMode() !== "source") return;
		const path = view.file.path;
		if (!Object.keys(this.settings.sync.files).some((held) => normalizePath(held) === path)) return;
		const state = leaf!.getViewState();
		void leaf!.setViewState({ ...state, state: { ...state.state, mode: "preview" } });
	}

	async syncNow(asked: boolean): Promise<void> {
		if (this.running) {
			if (asked) new Notice("Fold is already syncing.");
			return;
		}
		const { queryUrl, secretName, space, sendEdits } = this.connection;
		if (!queryAddress(queryUrl) || !secretName || !space) {
			if (asked) new Notice("Fold: set the address, the token and a space in this plugin's settings.");
			return;
		}
		this.running = true;
		// A round's work counts only while the vault is still what it started from: Disconnect or a new space, part way through, makes it moot. Obsidian closing does not, so what the round did is still saved.
		let mine = this.settings.sync;
		const stillOurs = () => this.settings.sync === mine && this.connection.space === space;
		const heldBefore = Object.keys(mine.files).length;
		try {
			const addresses = await this.addresses(queryUrl);
			if (!addresses) return;
			const client = foldClient(addresses, () => this.app.secretStorage.getSecret(secretName), requestUrl);
			if (sendEdits && !addresses.control && (asked || !this.saidNoControl)) {
				new Notice("Fold: to send your edits, enter the web app's address in this plugin's settings. Until then, notes are only copied.");
				this.saidNoControl = true;
			}
			const changed = Object.fromEntries(Object.entries(this.outbox).map(([path, entry]) => [path, entry.at]));
			const created = new Set(Object.entries(this.outbox).filter(([, entry]) => entry.created).map(([path]) => path));
			const outgoing = sendEdits && addresses.control ? { changed, created, quietSince: asked ? Date.now() : Date.now() - QUIET_MS } : undefined;
			const store = new VaultStore(this.app, (path, bytes) => this.ownWrites.set(path, bytes));
			const { state, report } = await syncSpace(client, store, mine, {
				space,
				force: asked,
				...(outgoing ? { outgoing } : {}),
				stopped: () => this.stopping || !stillOurs(),
				progress: (done, total) => this.statusBar?.setText(`Fold: ${done} of ${total}`),
				checkpoint: async (partial) => {
					if (!stillOurs()) return;
					this.settings.sync = mine = partial;
					await this.saveSettings();
				},
			});
			if (!stillOurs()) {
				this.statusBar?.setText("Fold");
				return;
			}
			// A path changed again during the round is offered again.
			if (report.done.length > 0) {
				for (const path of report.done) if (this.outbox[path]?.at === changed[path]) delete this.outbox[path];
				this.saveOutbox();
			}
			this.settings.sync = mine = state;
			await this.saveSettings();
			// Closing: what the round did is saved, and nothing more is shown or asked of Fold.
			if (this.stopping) return;
			if (report.stoppedBy !== undefined) {
				this.sayProblem(report.stoppedBy, asked);
				return;
			}
			this.lastProblem = null;
			const held = Object.keys(state.files).length;
			this.statusBar?.setText(describeHeld(held, report));
			if ((heldBefore === 0) !== (held === 0)) this.tab?.update();
			const said = describeRound(report, asked, this.alreadySaid);
			if (report.ran) this.alreadySaid = saidBy(report);
			if (said) new Notice(said);
			else if (asked) new Notice(report.ran && report.notes === 0 ? NO_NOTES : "Fold: up to date.");
		} catch (error) {
			this.sayProblem(error, asked);
		} finally {
			this.running = false;
			// The events a round's writes raise have come by now; what it wrote need not be held.
			window.setTimeout(() => {
				if (!this.running) this.ownWrites.clear();
			}, 5_000);
		}
	}

	/** A timer's round says a problem once, not every few minutes. */
	private sayProblem(problem: unknown, asked: boolean): void {
		// Fold's addresses are read again, in case its web app now names others.
		this.found = null;
		const words = describeRefusal(problem);
		this.statusBar?.setText("Fold: not synced");
		if (asked || words !== this.lastProblem) new Notice(`Fold: ${words}`);
		this.lastProblem = words;
	}
}
