/** The plugin's settings tab. The token stays in Obsidian's own secret storage, and its name, Fold's address and the chosen space stay on this device: only the state of the copy is saved in the vault, where it can be synced or committed with it. */
import { type App, Notice, PluginSettingTab, requestUrl, SecretComponent, Setting } from "obsidian";
import { foldClient, queryAddress } from "./fold";
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

	override display(): void {
		const { containerEl } = this;
		const { settings, connection } = this.plugin;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Fold query address")
			.setDesc("The HTTPS address of Fold's query part. Kept on this device, and not in the vault.")
			.addText((text) =>
				text.setValue(connection.queryUrl).onChange((value) => {
					connection.queryUrl = value.trim();
					this.plugin.saveConnection();
				}),
			);

		new Setting(containerEl)
			.setName("Token")
			.setDesc("A 1p personal access token with the fold:read scope, kept in Obsidian's secret storage. This plugin never writes to Fold, so it needs no more than that.")
			.addComponent((element) =>
				new SecretComponent(this.app, element).setValue(connection.secretName).onChange((name) => {
					connection.secretName = name ?? "";
					this.plugin.saveConnection();
				}),
			);

		const holdsNotes = Object.keys(settings.sync.files).length > 0;
		const space = new Setting(containerEl).setName("Space").setDesc(holdsNotes ? `Holding the notes of ${settings.sync.space}. Disconnect to choose another: the notes stay, and are no longer updated.` : "The space whose notes this vault holds. Use one vault per space, since a note's name is unique only within its space.");
		if (holdsNotes) {
			space.addButton((button) =>
				button.setButtonText("Disconnect").onClick(async () => {
					settings.sync = NOTHING_YET;
					connection.space = "";
					this.plugin.saveConnection();
					await this.plugin.saveSettings();
					new Notice("Fold: disconnected. The notes stay in this vault, and are no longer updated.");
					this.display();
				}),
			);
		} else {
			space.addDropdown((dropdown) => {
				dropdown.addOption("", "Choose a space");
				if (connection.space) dropdown.addOption(connection.space, connection.space);
				dropdown.setValue(connection.space).onChange((value) => {
					connection.space = value;
					this.plugin.saveConnection();
					void this.plugin.syncNow(true);
				});
				void this.loadSpaces().then((spaces) => {
					for (const { id, title } of spaces) dropdown.addOption(id, title);
					dropdown.setValue(connection.space);
				});
			});
		}

		new Setting(containerEl)
			.setName("Check for changes")
			.setDesc("While Obsidian is open. Asking whether a space has changed reads no notes.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(INTERVALS)
					.setValue(String(settings.intervalMinutes))
					.onChange(async (value) => {
						settings.intervalMinutes = Number(value);
						await this.plugin.saveSettings();
						this.plugin.schedule();
					}),
			);
	}

	private async loadSpaces(): Promise<{ id: string; title: string }[]> {
		const { queryUrl, secretName } = this.plugin.connection;
		const base = queryAddress(queryUrl);
		if (!base || !secretName) return [];
		try {
			const list = await foldClient(base, () => this.app.secretStorage.getSecret(secretName), requestUrl).listSpaces();
			return list.spaces.map(({ id, title }) => ({ id, title }));
		} catch (error) {
			new Notice(`Fold: ${describeRefusal(error)}`);
			return [];
		}
	}
}
