/** The plugin's settings tab, in Obsidian's declarative form, so its settings appear in Obsidian's settings search. The token stays in Obsidian's own secret storage, and its name, Fold's address and the chosen space stay on this device: only the state of the copy is saved in the vault, where it can be synced or committed with it. */
import { type App, type DropdownComponent, Notice, PluginSettingTab, requestUrl, type Setting, type SettingDefinitionItem } from "obsidian";
import type FoldMemoryPlugin from "./main";
import { missingSetup, probeFold, type Reach, reachFold, type SpaceChoice } from "./reach";
import { NOTHING_YET } from "./sync";
import { describeReach } from "./words";

const INTERVALS: Record<string, string> = { "1": "Every minute", "5": "Every 5 minutes", "15": "Every 15 minutes", "60": "Every hour" };
/** How long the address must rest before Fold is asked, so a half-typed address is not tried at every key. */
export const ADDRESS_PAUSE_MS = 700;
const ONE_VAULT = "Use one vault per space, since a note's name is unique only within its space.";

export class FoldSettingTab extends PluginSettingTab {
	/** The Space rows drawn now that offer a space. Obsidian may draw a row more than once, as for its settings search, and each shows the same answer. */
	private readonly rows = new Set<SpaceRow>();
	private addressPause: number | null = null;
	/** Only the latest question's answer is shown, and an abandoned one sends no token, since a slow answer for an older address may come last. */
	private asked = 0;

	constructor(
		app: App,
		private readonly plugin: FoldMemoryPlugin,
	) {
		super(app, plugin);
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Fold address",
				desc: "The address of Fold's web app, where you sign in. Kept on this device, and not in the vault.",
				aliases: ["query address", "web app"],
				control: { type: "text", key: "queryUrl", placeholder: "https://" },
			},
			{
				name: "Token",
				desc: "A 1p personal access token, kept in Obsidian's secret storage. The fold:read scope copies notes, and sending your edits needs fold:write.",
				control: { type: "secret", key: "secretName" },
			},
			// Drawn by hand, since its choices come from Fold, asked again when the address or the token changes, and once the vault holds notes it offers Disconnect instead.
			{ name: "Space", desc: "The space whose notes this vault holds.", render: (setting) => this.renderSpace(setting) },
			{
				name: "Send edits to Fold",
				desc: "Sends what you change in this vault from now on: an edit to a copied note, and a new note in inbox/. If a note changed in Fold meanwhile, Fold refuses your edit and both versions stay here. Deleting or renaming a note here never reaches Fold. Needs a token with fold:write, and edit access to the space, or contribute access for new notes.",
				aliases: ["write", "sync back", "two-way"],
				control: { type: "toggle", key: "sendEdits" },
			},
			{
				name: "Check for changes",
				desc: "While Obsidian is open. Asking whether a space has changed reads no notes.",
				control: { type: "dropdown", key: "intervalMinutes", options: INTERVALS },
			},
		];
	}

	/** The address and the token's name are on this device, and how often to check is in the vault's saved settings. */
	override getControlValue(key: string): unknown {
		const { connection, settings } = this.plugin;
		if (key === "queryUrl") return connection.queryUrl;
		if (key === "secretName") return connection.secretName;
		if (key === "sendEdits") return connection.sendEdits;
		if (key === "intervalMinutes") return String(settings.intervalMinutes);
		return undefined;
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const { connection, settings } = this.plugin;
		const text = typeof value === "string" ? value : "";
		if (key === "queryUrl" || key === "secretName") {
			connection[key] = key === "queryUrl" ? text.trim() : text;
			this.plugin.saveConnection();
			this.spacesAgain(key === "queryUrl" ? ADDRESS_PAUSE_MS : 0);
		} else if (key === "sendEdits") {
			this.plugin.setSending(value === true);
		} else if (key === "intervalMinutes" && text in INTERVALS) {
			settings.intervalMinutes = Number(text);
			await this.plugin.saveSettings();
			this.plugin.schedule();
		}
	}

	/** The Space row asks again once the address or the token changes, so a person never has to reopen the settings to see whether it connected. */
	private spacesAgain(pause: number): void {
		if (this.addressPause !== null) window.clearTimeout(this.addressPause);
		// The list is of the address before, so it goes at once: a space chosen from it now would be synced through the new one.
		if (pause > 0 && this.rows.size > 0) {
			this.asked += 1;
			this.show({ kind: "connecting" });
		}
		this.addressPause = window.setTimeout(() => {
			this.addressPause = null;
			this.ask(false);
		}, pause);
	}

	/**
	 * One question for every Space row. The address the person connected to is sent the token, as a round sends it. Any other may be half of one, so it is only asked whether it is Fold's web app, without the token, until they select Connect; once Fold lists their spaces there, it is the address they connected to.
	 */
	private ask(connect: boolean): void {
		if (this.rows.size === 0) return;
		const mine = ++this.asked;
		const { connection } = this.plugin;
		const secret = (name: string) => this.app.secretStorage.getSecret(name);
		const missing = missingSetup(connection, secret);
		this.show(missing ?? { kind: "connecting" });
		if (missing) return;
		// Fold's web app is read afresh, so one bad answer is not kept for this address.
		this.plugin.forgetAddresses();
		const address = connection.queryUrl;
		const addresses = (text: string) => this.plugin.addresses(text);
		const stillWanted = () => mine === this.asked;
		const question = connect || this.plugin.connected() ? reachFold(connection, secret, addresses, requestUrl, stillWanted) : probeFold(connection, addresses, stillWanted);
		void question.then((reach) => {
			if (!reach || !stillWanted()) return;
			if (connect && reach.kind === "connected") this.plugin.confirm(address);
			this.show(reach);
		});
	}

	private show(reach: Reach): void {
		const words = `${describeReach(reach, this.plugin.connection.space)} ${ONE_VAULT}`;
		for (const row of this.rows) row.show(words, reach.kind === "connected" ? reach.spaces : []);
	}

	/** Closing the settings, or leaving for another tab, drops every question still on its way, and any waiting for the address to rest. */
	override hide(): void {
		super.hide();
		if (this.addressPause !== null) window.clearTimeout(this.addressPause);
		this.addressPause = null;
		this.asked += 1;
		this.rows.clear();
	}

	private renderSpace(setting: Setting): () => void {
		const { settings, connection } = this.plugin;
		if (Object.keys(settings.sync.files).length > 0) {
			setting.setDesc(`Holding the notes of ${settings.sync.space}. Disconnect to choose another: the notes stay, and are no longer updated.`);
			setting.addButton((button) =>
				button.setButtonText("Disconnect").onClick(async () => {
					settings.sync = NOTHING_YET;
					connection.space = "";
					this.plugin.saveConnection();
					this.plugin.clearOutbox();
					await this.plugin.saveSettings();
					new Notice("Fold: disconnected. The notes stay in this vault, and are no longer updated.");
					this.update();
				}),
			);
			return () => {};
		}
		let row: SpaceRow | null = null;
		setting.addDropdown((dropdown) => {
			dropdown.onChange((value) => {
				connection.space = value;
				this.plugin.saveConnection();
				this.plugin.clearOutbox();
				void this.plugin.syncNow(true);
			});
			row = {
				show: (words, spaces) => {
					setting.setDesc(words);
					showSpaces(dropdown, connection.space, spaces);
				},
			};
		});
		setting.addButton((button) => button.setButtonText("Connect").onClick(() => this.ask(true)));
		if (!row) return () => {};
		const drawn: SpaceRow = row;
		this.rows.add(drawn);
		this.ask(false);
		return () => {
			this.rows.delete(drawn);
			if (this.rows.size === 0) this.asked += 1;
		};
	}
}

interface SpaceRow {
	show(words: string, spaces: readonly SpaceChoice[]): void;
}

/** The Space list as Fold gave it, keeping the space this device chose even when Fold no longer lists it, so a choice is never changed by a list. */
function showSpaces(dropdown: DropdownComponent, chosen: string, spaces: readonly SpaceChoice[]): void {
	const select = dropdown.selectEl;
	while (select.options.length > 0) select.remove(0);
	dropdown.addOption("", "Choose a space");
	if (chosen && !spaces.some(({ id }) => id === chosen)) dropdown.addOption(chosen, chosen);
	for (const { id, title } of spaces) dropdown.addOption(id, title);
	dropdown.setValue(chosen);
}
