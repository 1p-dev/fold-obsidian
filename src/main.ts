/** The plugin: settings, a timer and a command around one sync, and notes shown as read-only. */
import { MarkdownView, normalizePath, Notice, Plugin, requestUrl, type WorkspaceLeaf } from "obsidian";
import { foldClient, queryAddress } from "./fold";
import { type Connection, DEFAULT_INTERVAL_MINUTES, parseConnection, parseSaved, type Saved } from "./saved";
import { FoldSettingTab } from "./settings";
import { NOTHING_YET, syncSpace } from "./sync";
import { VaultStore } from "./vault-store";
import { describeHeld, describeRefusal, describeRound, saidBy } from "./words";

/** The key of the address and the secret's name in Obsidian's per-vault local storage. */
export const CONNECTION_KEY = "fold-memory-connection";

const NO_NOTES = "Fold: this space has no notes to copy.";

export default class FoldMemoryPlugin extends Plugin {
	override settings: Saved = { intervalMinutes: DEFAULT_INTERVAL_MINUTES, sync: NOTHING_YET };
	connection: Connection = { queryUrl: "", secretName: "", space: "" };
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
		this.statusBar = this.addStatusBarItem();
		this.addRibbonIcon("refresh-cw", "Fold: sync notes now", () => void this.syncNow(true));
		this.addCommand({ id: "sync-now", name: "Sync notes now", callback: () => void this.syncNow(true) });
		this.tab = new FoldSettingTab(this.app, this);
		this.addSettingTab(this.tab);
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.showAsRead(leaf)));
		this.registerEvent(this.app.workspace.on("file-open", () => this.showAsRead(this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ?? null)));
		this.app.workspace.onLayoutReady(() => {
			this.schedule();
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

	schedule(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = this.registerInterval(window.setInterval(() => void this.syncNow(false), this.settings.intervalMinutes * 60_000));
	}

	/** A note here is a copy, so it opens for reading: an edit would not reach Fold. */
	private showAsRead(leaf: WorkspaceLeaf | null): void {
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
		const { queryUrl, secretName, space } = this.connection;
		const base = queryAddress(queryUrl);
		if (!base || !secretName || !space) {
			if (asked) new Notice("Fold: set the query address, the token and a space in this plugin's settings.");
			return;
		}
		this.running = true;
		// A round's work counts only while the vault is still what it started from: Disconnect or a new space, part way through, makes it moot. Obsidian closing does not, so what the round did is still saved.
		let mine = this.settings.sync;
		const stillOurs = () => this.settings.sync === mine && this.connection.space === space;
		const heldBefore = Object.keys(mine.files).length;
		try {
			const client = foldClient(base, () => this.app.secretStorage.getSecret(secretName), requestUrl);
			const { state, report } = await syncSpace(client, new VaultStore(this.app), mine, {
				space,
				force: asked,
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
			if ((heldBefore === 0) !== (held === 0)) this.tab?.display();
			const said = describeRound(report, asked, this.alreadySaid);
			if (report.ran) this.alreadySaid = saidBy(report);
			if (said) new Notice(said);
			else if (asked) new Notice(report.ran && report.notes === 0 ? NO_NOTES : "Fold: up to date.");
		} catch (error) {
			this.sayProblem(error, asked);
		} finally {
			this.running = false;
		}
	}

	/** A timer's round says a problem once, not every few minutes. */
	private sayProblem(problem: unknown, asked: boolean): void {
		const words = describeRefusal(problem);
		this.statusBar?.setText("Fold: not synced");
		if (asked || words !== this.lastProblem) new Notice(`Fold: ${words}`);
		this.lastProblem = words;
	}
}
