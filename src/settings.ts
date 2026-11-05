/** The plugin's settings tab, in Obsidian's declarative form, so its settings appear in Obsidian's settings search. The token stays in Obsidian's own secret storage, and its name, Fold's address and the chosen space stay on this device: only the state of the copy is saved in the vault, where it can be synced or committed with it. */
import { type App, Notice, PluginSettingTab, requestUrl, type Setting, type SettingDefinitionItem } from "obsidian";
import { foldClient } from "./fold";
import type FoldMemoryPlugin from "./main";
import { NOTHING_YET } from "./sync";
import { describeRefusal } from "./words";

const INTERVALS: Record<string, string> = { "1": "Every minute", "5": "Every 5 minutes", "15": "Every 15 minutes", "60": "Every hour" };

export class FoldSettingTab extends PluginSettingTab {
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
			// Drawn by hand, since its choices come from Fold when the tab opens, and once the vault holds notes it offers Disconnect instead.
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
		} else if (key === "sendEdits") {
			this.plugin.setSending(value === true);
		} else if (key === "intervalMinutes" && text in INTERVALS) {
			settings.intervalMinutes = Number(text);
			await this.plugin.saveSettings();
			this.plugin.schedule();
		}
	}

	private renderSpace(setting: Setting): void {
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
			return;
		}
		setting.setDesc("The space whose notes this vault holds. Use one vault per space, since a note's name is unique only within its space.");
		setting.addDropdown((dropdown) => {
			dropdown.addOption("", "Choose a space");
			if (connection.space) dropdown.addOption(connection.space, connection.space);
			dropdown.setValue(connection.space).onChange((value) => {
				connection.space = value;
				this.plugin.saveConnection();
				this.plugin.clearOutbox();
				void this.plugin.syncNow(true);
			});
			void this.loadSpaces().then((spaces) => {
				for (const { id, title } of spaces) dropdown.addOption(id, title);
				dropdown.setValue(connection.space);
			});
		});
	}

	private async loadSpaces(): Promise<{ id: string; title: string }[]> {
		const { queryUrl, secretName } = this.plugin.connection;
		if (!secretName) return [];
		try {
			const addresses = await this.plugin.addresses(queryUrl);
			if (!addresses) return [];
			const list = await foldClient(addresses, () => this.app.secretStorage.getSecret(secretName), requestUrl).listSpaces();
			return list.spaces.map(({ id, title }) => ({ id, title }));
		} catch (error) {
			new Notice(`Fold: ${describeRefusal(error)}`);
			return [];
		}
	}
}
