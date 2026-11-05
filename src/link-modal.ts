/** What a link from Fold's web app asks a person before this vault takes a space, naming the space as Fold reports it to them, never as the link does. */
import { type App, Modal, Setting } from "obsidian";

export class ConnectModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly organisation: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.setTitle("Connect this vault to this space?");
		this.contentEl.createEl("p", { text: `${this.title}, in ${this.organisation}.` });
		this.contentEl.createEl("p", { text: "Its notes are copied into this vault. Sending your edits stays off until you turn it on in this plugin's settings." });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Connect")
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
